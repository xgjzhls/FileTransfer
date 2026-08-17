#!/usr/bin/env node
/**
 * stun-server.js — 迷你 STUN 服务器（RFC 8489 §6）。
 * 只做一件事：把收到的 Binding Request 的「源地址」按 XOR 规则加密后，
 * 放进 XOR-MAPPED-ADDRESS 属性原样回给客户端。
 *
 * 这整份文件约 60 行 —— 说明「STUN 服务器是一面镜子」不是比喻，是字面意思。
 * 生产服务器（coturn 等）多做的只是：多租户、配额、RFC 5780 NAT 行为探测、
 * TURN 中继功能。
 *
 * 运行:
 *   node stun-server.js 3478
 * 另开一个终端:
 *   node stun-client.js 127.0.0.1 3478
 */
'use strict';

const dgram = require('dgram');

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED = 0x0020;
const ATTR_SOFTWARE = 0x8022;              // 可选属性：告诉客户端我是什么软件

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) | parseInt(oct, 10), 0) >>> 0;
}

function buildResponse(buf, rinfo) {
  const txid = buf.slice(8, 20);           // 回包必须原样回传事务 ID
  const type = buf.readUInt16BE(0);
  if (type !== BINDING_REQUEST) return null;   // 只认识 Binding Request

  // XOR-MAPPED-ADDRESS 属性值：0x00 | family=0x01 | X-Port | X-Address
  const attr = Buffer.alloc(8);
  attr[1] = 0x01;
  attr.writeUInt16BE(rinfo.port ^ 0x2112, 2);           // 端口 XOR 魔数高 16 位
  attr.writeUInt32BE((ipToInt(rinfo.address) ^ MAGIC_COOKIE) >>> 0, 4);  // IP XOR 魔数

  // SOFTWARE 属性值，补零到 4 字节对齐（对齐是 STUN 的硬性规则）
  const swRaw = Buffer.from('mini-stun/0.1', 'ascii');   // 13 字节
  const sw = Buffer.alloc(16);                          // 16 = 对齐后的长度
  swRaw.copy(sw);

  // 两个属性各 = 4 字节 TLV 头 + 值；长度字段不含 20 字节头
  const payloadLen = (4 + 8) + (4 + sw.length);

  const res = Buffer.alloc(20 + payloadLen);
  res.writeUInt16BE(BINDING_SUCCESS, 0);
  res.writeUInt16BE(payloadLen, 2);
  res.writeUInt32BE(MAGIC_COOKIE, 4);
  txid.copy(res, 8);

  let off = 20;
  res.writeUInt16BE(ATTR_XOR_MAPPED, off); res.writeUInt16BE(8, off + 2); attr.copy(res, off + 4);
  off += 12;
  res.writeUInt16BE(ATTR_SOFTWARE, off); res.writeUInt16BE(swRaw.length, off + 2); sw.copy(res, off + 4);
  return res;
}

const port = parseInt(process.argv[2] || '3478', 10);
const sock = dgram.createSocket('udp4');

sock.on('message', (buf, rinfo) => {
  const res = buildResponse(buf, rinfo);
  if (!res) return;
  sock.send(res, rinfo.port, rinfo.address);
  console.log(`↩  ${rinfo.address}:${rinfo.port}  →  src=${rinfo.address}:${rinfo.port}  (${buf.length}B → ${res.length}B)`);
});

sock.bind(port, () => {
  console.log(`★ mini STUN server 监听 udp://0.0.0.0:${port}`);
  console.log('  另开终端运行: node stun-client.js 127.0.0.1 ' + port);
});
