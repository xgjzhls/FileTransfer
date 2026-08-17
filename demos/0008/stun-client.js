#!/usr/bin/env node
/**
 * stun-client.js — 徒手构造 STUN Binding Request（RFC 8489 §6），
 * 发到真实 STUN 服务器，解析 XOR-MAPPED-ADDRESS，得到自己的公网地址。
 *
 * 零依赖，只用 Node 内置模块。这就是浏览器 STUN 客户端做的事的极小版
 * —— 不同的是浏览器替你封装了，这里我们亲手写。
 *
 * 运行:
 *   node stun-client.js                          # 默认 stun.cloudflare.com:3478
 *   node stun-client.js stun.l.google.com 19302
 */
'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC_COOKIE = 0x2112a442;   // RFC 8489 §6：固定魔数
const BINDING_REQUEST = 0x0001;    // 方法 Binding(0x001) + 类 request(0b00)
const BINDING_SUCCESS = 0x0101;    // 方法 Binding(0x001) + 类 success(0b10)
const ATTR_XOR_MAPPED = 0x0020;    // XOR-MAPPED-ADDRESS

/* ---------------- 构造：Binding Request（20 字节头，无属性） ---------------- */

function buildBindingRequest() {
  const txid = crypto.randomBytes(12);      // 96-bit 事务 ID，必须随机
  const msg = Buffer.alloc(20);             // STUN 头固定 20 字节
  msg.writeUInt16BE(BINDING_REQUEST, 0);    // ① 类型（2B）
  msg.writeUInt16BE(0, 2);                  // ② 长度（2B，不含头部；无属性 → 0）
  msg.writeUInt32BE(MAGIC_COOKIE, 4);       // ③ 魔数（4B）
  txid.copy(msg, 8);                        // ④ 事务 ID（12B）
  return msg;
}

/* ---------------- 解析：遍历 TLV 属性 ---------------- */

function parseAttrs(msg) {
  const attrs = [];
  let off = 20;                             // 跳过 20 字节头
  while (off + 4 <= msg.length) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    attrs.push({ type, len, value: msg.slice(off + 4, off + 4 + len) });
    const pad = (4 - (len % 4)) % 4;        // 属性值补零到 4 字节对齐
    off += 4 + len + pad;
  }
  return attrs;
}

function decodeXorMapped(attr) {
  // 属性值：1 字节保留 | 1 字节 family | 2 字节 X-Port | 4/16 字节 X-Address
  if (attr.len < 8) return null;
  if (attr.value[1] !== 0x01) return null;   // 0x01 = IPv4
  const xport = attr.value.readUInt16BE(2);
  const port = xport ^ 0x2112;               // X-Port XOR 魔数高 16 位 → 真端口
  const xip = attr.value.readUInt32BE(4);
  const ip = (xip ^ MAGIC_COOKIE) >>> 0;     // X-Address XOR 整个魔数 → 真 IP
  return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}:${port}`;
}

/* ---------------- 输出：带字段注释的十六进制 ---------------- */

function hexDump(msg) {
  const lines = [];
  for (let i = 0; i < msg.length; i += 16) {
    const hex = Array.from(msg.slice(i, i + 16))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    lines.push(String(i).padStart(3) + '  ' + hex);
  }
  return lines.join('\n');
}

function explainHeader(msg) {
  const type = msg.readUInt16BE(0).toString(16).padStart(4, '0');
  const len = msg.readUInt16BE(2);
  const cookie = msg.readUInt32BE(4).toString(16).padStart(8, '0');
  const txid = msg.slice(8, 20).toString('hex');
  return `   类型=0x${type}  长度=${len}  魔数=0x${cookie}  事务ID=${txid}`;
}

/* ---------------- 主流程 ---------------- */

function main() {
  const server = process.argv[2] || 'stun.cloudflare.com';
  const port = parseInt(process.argv[3] || '3478', 10);

  const req = buildBindingRequest();
  const sock = dgram.createSocket('udp4');

  console.log(`▶ 向 ${server}:${port} 发送 Binding Request（${req.length} 字节）\n`);
  console.log(hexDump(req));
  console.log('\n' + explainHeader(req));
  console.log('\n（此刻你的 NAT 已为这个目的地址建立了一个映射，并分配了公网端口）\n');

  const timer = setTimeout(() => {
    console.error('✗ 超时：UDP 无回应（被防火墙拦？服务器不可达？）');
    sock.close();
    process.exit(1);
  }, 3000);

  sock.on('message', (res) => {
    clearTimeout(timer);
    console.log(`◀ 收到响应（${res.length} 字节）\n`);
    console.log(hexDump(res));
    console.log('\n' + explainHeader(res));

    const attrs = parseAttrs(res);
    console.log('\n属性:');
    for (const a of attrs) {
      const hex = a.value.toString('hex');
      if (a.type === ATTR_XOR_MAPPED) {
        console.log(`  0x${a.type.toString(16).padStart(4, '0')} XOR-MAPPED-ADDRESS  ${hex}  →  ${decodeXorMapped(a)}`);
      } else {
        console.log(`  0x${a.type.toString(16).padStart(4, '0')} (len=${a.len})  ${hex}`);
      }
    }

    if (res.readUInt16BE(0) !== BINDING_SUCCESS) {
      console.error('\n✗ 不是成功响应（非 0x0101）');
    } else {
      const mapped = attrs.filter((a) => a.type === ATTR_XOR_MAPPED)
        .map(decodeXorMapped).find(Boolean);
      console.log(mapped
        ? `\n✅ 你的公网地址（XOR-MAPPED-ADDRESS）= ${mapped}`
        : '\n✗ 响应里没有 XOR-MAPPED-ADDRESS');
      console.log('\n提示：这个地址只对「这个 STUN 服务器」有效。对称 NAT 下发给别的目的地址',
        '\n     会是另一个端口（第 3 课讲过：映射按目的地址区分）。');
    }
    sock.close();
  });

  sock.send(req, port, server, (err) => {
    if (err) { clearTimeout(timer); console.error('✗ 发送失败:', err.message); process.exit(1); }
  });
}

main();
