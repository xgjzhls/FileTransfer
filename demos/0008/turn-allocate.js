#!/usr/bin/env node
/**
 * turn-allocate.js — 徒手完成 TURN Allocate 的完整「认证舞蹈」（RFC 8656 §4.2）。
 *
 * 流程（第 6 课讲过概念，这里是字节级实现）:
 *   1. 发 Allocate（带 REQUESTED-TRANSPORT，无凭据）
 *   2. 服务器回 401 + REALM + NONCE（"你是谁？"）
 *   3. 用 MD5(user:realm:pass) 作密钥，加 USERNAME/REALM/NONCE + MESSAGE-INTEGRITY
 *      重发 Allocate（"我是 user，证明如下"）
 *   4. 服务器回 0x0103 成功：XOR-RELAYED-ADDRESS（你的中继地址）+ LIFETIME + XOR-MAPPED-ADDRESS
 *
 * 前置条件：本地跑一个 coturn（见 README.md），例如:
 *   docker run -d --rm --name coturn-demo --network=host coturn/coturn \
 *     -n --log-file=stdout --lt-cred-mech --realm=example.org \
 *     --user=alice:secret123 --fingerprint --min-port=49160 --max-port=49200
 *
 * 运行:
 *   node turn-allocate.js
 *   node turn-allocate.js alice secret123 example.org 127.0.0.1 3478
 */
'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC_COOKIE = 0x2112a442;

// 方法（RFC 8656 §13）
const ALLOCATE = 0x003;

// 类编码：请求 0b00 / 指示 0b01 / 成功响应 0b10 / 错误响应 0b11
const CLASS_REQUEST = 0x00;
const CLASS_SUCCESS = 0x02;
const CLASS_ERROR = 0x03;

// 属性
const USERNAME = 0x0006;
const MESSAGE_INTEGRITY = 0x0008;
const REALM = 0x0014;
const NONCE = 0x0015;
const REQUESTED_TRANSPORT = 0x0019;
const XOR_MAPPED = 0x0020;
const FINGERPRINT = 0x8028;
const XOR_RELAYED = 0x0016;
const LIFETIME = 0x000d;

/* ---------------- 基础工具 ---------------- */

// STUN 的 type 字段里，class 位（C1=bit8，C0=bit4）与 method 位交错分布
// （RFC 8489 §6）。RFC 5389 自己吐槽过这个编码 "unfortunate" —— 因为
// 早期版本没为 indication/success/error 预留位，后来只能插空补。
function messageType(method, klass) {
  const m = (method & 0x0f) | ((method & 0x70) << 1) | ((method & 0xf80) << 2);
  const c1 = klass & 0x2 ? 0x0100 : 0;
  const c0 = klass & 0x1 ? 0x0010 : 0;
  return m | c1 | c0;
}

function decodeMessageType(type) {
  const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
  const klass = ((type & 0x0100) ? 2 : 0) | ((type & 0x0010) ? 1 : 0);
  return { method, klass };
}

function attr(type, value) {
  // STUN 硬性规则：每个属性值都要补零到 4 字节对齐。补的字节不算进
  // length 字段，但在线上存在、也参与 MESSAGE-INTEGRITY / FINGERPRINT。
  const pad = (4 - (value.length % 4)) % 4;
  const buf = Buffer.alloc(4 + value.length + pad);
  buf.writeUInt16BE(type, 0);
  buf.writeUInt16BE(value.length, 2);
  value.copy(buf, 4);
  return buf;
}

/* ---------------- FINGERPRINT：CRC-32 ^ 0x5354554E（RFC 8489 §14.5） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- 构造带认证的 Allocate ---------------- */

function buildAllocate({ username, realm, nonce, key }) {
  const reqTransport = Buffer.from([0x11, 0x00, 0x00, 0x00]); // 17=UDP + 3 保留字节
  const parts = [
    attr(REQUESTED_TRANSPORT, reqTransport),
    attr(USERNAME, Buffer.from(username, 'utf8')),
    attr(REALM, Buffer.from(realm, 'utf8')),
    attr(NONCE, Buffer.from(nonce, 'utf8')),
  ];

  const headerAndAttrs = Buffer.concat(parts);
  const miLen = headerAndAttrs.length + 24;   // 长度先只算到 MI 结束（不含 FP）
  const msg = Buffer.alloc(20 + miLen + 8);   // 预分配含 FINGERPRINT 的完整空间

  msg.writeUInt16BE(messageType(ALLOCATE, CLASS_REQUEST), 0);
  // 关键顺序：HMAC 计算时，长度字段必须是不含 FINGERPRINT 的值
  // （coturn 校验时会把长度改回“到 MI 结束”再算 HMAC —— 见 ns_turn_msg.c）
  msg.writeUInt16BE(miLen, 2);
  msg.writeUInt32BE(MAGIC_COOKIE, 4);
  crypto.randomBytes(12).copy(msg, 8);
  headerAndAttrs.copy(msg, 20);

  let off = 20 + headerAndAttrs.length;
  // HMAC-SHA1，密钥 = MD5(username:realm:password)，覆盖到 MI 属性之前
  const hmac = crypto.createHmac('sha1', key).update(msg.slice(0, off)).digest();
  msg.writeUInt16BE(MESSAGE_INTEGRITY, off); msg.writeUInt16BE(20, off + 2); hmac.copy(msg, off + 4);
  off += 24;

  // FINGERPRINT：最后追加；追加后把长度字段更新为含 FP 的最终值
  // （FP 的 CRC 覆盖到 FP 属性之前，且此时长度字段必须已含 FP —— RFC 8489 §14.5）
  msg.writeUInt16BE(FINGERPRINT, off); msg.writeUInt16BE(4, off + 2);
  msg.writeUInt16BE(miLen + 8, 2);
  const fp = (crc32(msg.slice(0, off)) ^ 0x5354554e) >>> 0;
  msg.writeUInt32BE(fp, off + 4);

  return msg;
}

function buildBareAllocate() {
  const reqTransport = Buffer.from([0x11, 0x00, 0x00, 0x00]);
  const a = attr(REQUESTED_TRANSPORT, reqTransport);
  const msg = Buffer.alloc(20 + a.length);
  msg.writeUInt16BE(messageType(ALLOCATE, CLASS_REQUEST), 0);
  msg.writeUInt16BE(a.length, 2);
  msg.writeUInt32BE(MAGIC_COOKIE, 4);
  crypto.randomBytes(12).copy(msg, 8);
  a.copy(msg, 20);
  return msg;
}

/* ---------------- 解析 ---------------- */

function parseAttrs(msg) {
  const attrs = [];
  let off = 20;
  while (off + 4 <= msg.length) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    attrs.push({ type, value: msg.slice(off + 4, off + 4 + len), headerOff: off });
    const pad = (4 - (len % 4)) % 4;
    off += 4 + len + pad;
  }
  return attrs;
}

// 自查：复刻 coturn 的校验逻辑（stun_check_message_integrity_by_key_str）：
// 1) 先把头部长度字段临时改成“到 MI 属性结束”的值，再算 HMAC；
// 2) FINGERPRINT 的 CRC 覆盖到 FP 属性之前，且长度字段已含 FP。
function verifyMessage(msg, key) {
  const attrs = parseAttrs(msg);
  const mi = attrs.find((a) => a.type === MESSAGE_INTEGRITY);
  const fp = attrs.find((a) => a.type === FINGERPRINT);
  const savedLen = msg.readUInt16BE(2);
  msg.writeUInt16BE(mi.headerOff + 4, 2);   // new_len = MI位置 + 4 + 20；字段值 = new_len − 20
  const okMi = mi && crypto.createHmac('sha1', key)
    .update(msg.slice(0, mi.headerOff)).digest().equals(mi.value);
  msg.writeUInt16BE(savedLen, 2);
  const okFp = fp && ((crc32(msg.slice(0, fp.headerOff)) ^ 0x5354554e) >>> 0)
    === fp.value.readUInt32BE(0);
  if (!okMi) console.log('  ⚠ 自查：MESSAGE-INTEGRITY 对不上！');
  if (!okFp) console.log('  ⚠ 自查：FINGERPRINT 对不上！');
  return okMi && okFp;
}

function addrOf(attrValue) {
  if (attrValue.length < 8 || attrValue[1] !== 0x01) return null;
  const port = attrValue.readUInt16BE(2) ^ 0x2112;
  const ip = (attrValue.readUInt32BE(4) ^ MAGIC_COOKIE) >>> 0;
  return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}:${port}`;
}

/* ---------------- 主流程 ---------------- */

function main() {
  const [user, pass, realm, host, port] = [
    process.argv[2] || 'alice',
    process.argv[3] || 'secret123',
    process.argv[4] || 'example.org',
    process.argv[5] || '127.0.0.1',
    parseInt(process.argv[6] || '3478', 10),
  ];

  const sock = dgram.createSocket('udp4');
  let key = null;                       // 401 后才有 realm，才能算密钥
  let authedSent = false;               // 防止认证失败时无限循环

  function send(msg, label) {
    console.log(`\n▶ [${label}] 发送 ${msg.length} 字节 → ${host}:${port}`);
    console.log('  type=0x' + msg.readUInt16BE(0).toString(16).padStart(4, '0') +
      '  len=' + msg.readUInt16BE(2) + '  txid=' + msg.slice(8, 20).toString('hex').slice(0, 8) + '…');
    sock.send(msg, port, host);
  }

  const timer = setTimeout(() => { console.error('\n✗ 超时。coturn 在跑吗？（docker ps）'); sock.close(); process.exit(1); }, 4000);

  sock.on('message', (res) => {
    const { method, klass } = decodeMessageType(res.readUInt16BE(0));
    const attrs = parseAttrs(res);
    const get = (t) => attrs.find((a) => a.type === t);

    if (method === ALLOCATE && klass === CLASS_ERROR) {
      // 401/438：取出 realm + nonce 与错误码，带凭据重发
      const realmA = get(REALM);
      const nonceA = get(NONCE);
      const errAttr = get(0x0009);   // ERROR-CODE：2 保留 + 1 class + 1 number
      const code = errAttr && errAttr.value.length >= 4
        ? errAttr.value[2] * 100 + errAttr.value[3] : '?';
      if (authedSent && code !== 438) {
        console.error(`\n✗ 带凭据重发仍被拒（${code}）。多半是 MESSAGE-INTEGRITY/属性对齐问题。`);
        sock.close(); process.exit(1);
      }
      if (!realmA || !nonceA) {
        console.error('\n✗ 错误响应缺 REALM/NONCE，无法继续。');
        sock.close(); process.exit(1);
      }
      const realmS = realmA.value.toString('utf8');
      const nonceS = nonceA.value.toString('utf8');
      key = crypto.createHash('md5').update(`${user}:${realmS}:${pass}`).digest();
      console.log(`◀ [${code}] 服务器要求认证：realm="${realmS}" nonce="${nonceS.slice(0, 8)}…"`);
      console.log('  key = MD5("' + user + ':' + realmS + ':' + pass + '") = ' + key.toString('hex'));
      console.log('  现在把 USERNAME/REALM/NONCE/MESSAGE-INTEGRITY 加进报文重发…');
      const authedMsg = buildAllocate({ username: user, realm: realmS, nonce: nonceS, key });
      verifyMessage(authedMsg, key);
      send(authedMsg, 'Allocate(带凭据)');
      authedSent = true;
      return;
    }

    if (method === ALLOCATE && klass === CLASS_SUCCESS) {
      clearTimeout(timer);
      console.log('\n✅ Allocate 成功！');
      const relayed = addrOf(get(XOR_RELAYED).value);
      const mapped = addrOf(get(XOR_MAPPED).value);
      const life = get(LIFETIME) ? get(LIFETIME).value.readUInt32BE(0) : '?';
      console.log('  XOR-RELAYED-ADDRESS = ' + relayed + '   ← 你的中继地址（第 6 课的 relay 候选）');
      console.log('  XOR-MAPPED-ADDRESS  = ' + mapped + '   ← 服务器看到的你的公网地址（顺便兼职 STUN）');
      console.log('  LIFETIME            = ' + life + ' 秒（默认 600 = 10 分钟，到期前要发 Refresh）');
      console.log('\n对端把 UDP 包发到 ' + relayed + '，coturn 就会转给你。');
      console.log('一个分配同时服务多个对端 —— 每个对端要先 CreatePermission 授权（第 6 课）。');
      sock.close();
      process.exit(0);
    }

    console.error('\n◀ 未预期的响应: type=0x' + res.readUInt16BE(0).toString(16).padStart(4, '0'));
    sock.close(); process.exit(1);
  });

  send(buildBareAllocate(), 'Allocate(无凭据)');
}

main();
