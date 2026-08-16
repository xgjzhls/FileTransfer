/**
 * 原生信令通道协议（ADR-0009 / T04）—— JS 侧 schema、帧编解码、竞态判定的参考实现。
 *
 * 用途：
 * - facade（index.ts）在委托原生前做参数校验（sendMessage / connect）
 * - 单测 + Node 真实 TCP 集成测试钉死 wire 格式（channel.integration.test.ts）
 * - Swift / Java 原生侧按同一协议镜像实现（帧格式/消息 schema/竞态规则逐条对齐）
 *
 * Wire 协议（v1，明文 TCP；TLS 留 [v2]，见 SPEC §5.5 与 T04 设计定稿）：
 * - 帧 = 4 字节大端长度前缀 + UTF-8 JSON 载荷；单帧上限 MAX_FRAME_BYTES（超限 = 协议违规）
 * - 消息：
 *   - hello（发起方连上即发，接收方不回）：{v:1,type:"hello",id, session} —— id = 发起方
 *     deviceId（接收方据此竞态判定）；session = 配对会话 token（双方 JS 以它作配对状态键）
 *   - signal（双向）：{v:1,type:"signal",kind:"offer"|"answer",sdp} —— 与 SPEC §5.1
 *     signal.payload 同结构；sdp 为 gzip+base64url（压缩约定与 WS/QR 同一套，原生透明）
 * - TCP 断开 = 断线（v1 无 bye）
 *
 * 竞态（两台同时发起）：低 deviceId 胜 —— 幸存连接 = 低 id 方发起的连接；
 * 我 id < 对端 id → 保我出向；我 id > 对端 id → 保入向。两侧独立套同一规则收敛到同一连接。
 * deviceId 字符串按 Unicode 标量字典序比较（UUID 小写十六进制，两端一致）。
 *
 * 纯函数、无 @capacitor 依赖（同 txt.ts / registry.ts 模式），便于单测。
 */
import type { DeviceInfo } from './txt'

/** 帧长度前缀字节数（4 字节大端） */
export const FRAME_LENGTH_BYTES = 4

/** 单帧上限（字节）：压缩 SDP 数 KB、hello 极小；超限 = 协议违规，关闭连接 */
export const MAX_FRAME_BYTES = 64 * 1024

/** 默认信令端口（SPEC §5.5；PORT_IN_USE 时 JS 依次试 8444/8445） */
export const DEFAULT_SIGNALING_PORT = 8443

/** 连接超时（原生侧 connect 兜底） */
export const CONNECT_TIMEOUT_MS = 10_000

/** 协议版本（所有消息携带） */
export const PROTOCOL_VERSION = 1

/** 错误码词汇表（原生侧与 facade 共用；signalingError 事件的 code） */
export const CHANNEL_ERRORS = {
  PORT_IN_USE: 'PORT_IN_USE',
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  HOST_UNKNOWN: 'HOST_UNKNOWN',
  /** v1 留位（hello.id ≠ 期望 peerId 的校验，T04 设计定稿）——当前无代码发出 */
  PEER_MISMATCH: 'PEER_MISMATCH',
  NOT_CONNECTED: 'NOT_CONNECTED',
  ALREADY_CONNECTING: 'ALREADY_CONNECTING',
  PROTOCOL_VIOLATION: 'PROTOCOL_VIOLATION',
  INVALID_PARAMS: 'INVALID_PARAMS',
} as const
export type ChannelErrorCode = (typeof CHANNEL_ERRORS)[keyof typeof CHANNEL_ERRORS]

export type SignalKind = 'offer' | 'answer'

export interface HelloMessage {
  v: 1
  type: 'hello'
  /** 发起方 deviceId（权威身份） */
  id: string
  /** 配对会话 token */
  session: string
}

export interface SignalMessage {
  v: 1
  type: 'signal'
  kind: SignalKind
  /** gzip+base64url 的 SDP（与 WS/QR 同一压缩约定；对原生透明） */
  sdp: string
}

export type ChannelMessage = HelloMessage | SignalMessage

/** 协议/参数非法（帧坏、schema 不符、参数越界） */
export class ChannelProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelProtocolError'
  }
}

/** 帧长度超过 MAX_FRAME_BYTES（原生侧按协议违规关闭连接） */
export class FrameTooLargeError extends Error {
  constructor(length: number) {
    super(`帧长度 ${length} 超过上限 64 KiB（${MAX_FRAME_BYTES} 字节）`)
    this.name = 'FrameTooLargeError'
  }
}

/** 生成配对会话 token（uuid v4；WKWebView capacitor:// 与 Node ≥19 均有 crypto.randomUUID） */
export function newSessionToken(): string {
  return crypto.randomUUID()
}

// ---------------------------------------------------------------------------
// 消息构建与校验
// ---------------------------------------------------------------------------

export function makeHello(id: string, session: string): HelloMessage {
  return { v: PROTOCOL_VERSION, type: 'hello', id, session }
}

export function makeSignal(kind: SignalKind, sdp: string): SignalMessage {
  return { v: PROTOCOL_VERSION, type: 'signal', kind, sdp }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/** 校验未知载荷是否为合法 ChannelMessage；非法抛 ChannelProtocolError */
export function validateChannelMessage(value: unknown): ChannelMessage {
  if (typeof value !== 'object' || value === null) {
    throw new ChannelProtocolError('消息必须是对象')
  }
  const msg = value as Record<string, unknown>
  if (msg.v !== PROTOCOL_VERSION) {
    throw new ChannelProtocolError(`不支持的消息版本 v：${String(msg.v)}（期望 ${PROTOCOL_VERSION}）`)
  }
  switch (msg.type) {
    case 'hello':
      if (!isNonEmptyString(msg.id)) throw new ChannelProtocolError('hello 缺 id')
      if (!isNonEmptyString(msg.session)) throw new ChannelProtocolError('hello 缺 session')
      return msg as unknown as HelloMessage
    case 'signal':
      return validateSignalPayload(msg.kind as SignalKind, msg.sdp)
    default:
      throw new ChannelProtocolError(`未知消息类型：${String(msg.type)}`)
  }
}

/** 校验 signal 载荷（facade sendMessage 在委托原生前调用；kind/sdp 与 SPEC §5.1 一致） */
export function validateSignalPayload(kind: unknown, sdp: unknown): SignalMessage {
  if (kind !== 'offer' && kind !== 'answer') {
    throw new ChannelProtocolError(`kind 必须是 offer/answer：${String(kind)}`)
  }
  if (!isNonEmptyString(sdp)) {
    throw new ChannelProtocolError('sdp 必须是非空字符串（gzip+base64url）')
  }
  return { v: PROTOCOL_VERSION, type: 'signal', kind, sdp }
}

// ---------------------------------------------------------------------------
// 帧编解码（wire 格式参考实现；Swift/Java 按同格式镜像）
// ---------------------------------------------------------------------------

/** 编码：4B 大端长度前缀 + UTF-8 JSON */
export function encodeFrame(message: ChannelMessage): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message))
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(payload.byteLength)
  }
  const frame = new Uint8Array(FRAME_LENGTH_BYTES + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false) // 大端
  frame.set(payload, FRAME_LENGTH_BYTES)
  return frame
}

/**
 * 解析 4 字节长度前缀（大端）；超上限抛 FrameTooLargeError。
 * 原生读循环两段式：先读 4B 得到长度，再读恰好 length 字节载荷。
 */
export function decodeFrameLength(lengthBytes: Uint8Array): number {
  if (lengthBytes.byteLength < FRAME_LENGTH_BYTES) {
    throw new ChannelProtocolError('长度前缀不足 4 字节')
  }
  const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, FRAME_LENGTH_BYTES).getUint32(0, false)
  if (length > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(length)
  }
  return length
}

/** 解码载荷：JSON 解析 + schema 校验；非法抛 ChannelProtocolError */
export function decodeFrame(payload: Uint8Array): ChannelMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    throw new ChannelProtocolError('载荷不是合法 JSON')
  }
  return validateChannelMessage(parsed)
}

// ---------------------------------------------------------------------------
// 竞态判定
// ---------------------------------------------------------------------------

/** 竞态冲突时保留哪条连接（对我而言） */
export type ConflictDecision = 'keep-outbound' | 'keep-inbound'

/**
 * 双发起竞态消解（两台同时点选互拨）：
 * 幸存连接 = **由较低 deviceId 一方发起** 的那条。
 * - 我 id < 对端 id → 我的出向胜（keep-outbound）
 * - 我 id > 对端 id → 入向胜（keep-inbound）
 * 两侧独立套同一规则 → 收敛到同一连接，不产生双连接。
 * deviceId 相等（部署错误，不应发生）→ 保守取 keep-inbound（规则确定）。
 */
export function resolveChannelConflict(myId: string, peerId: string): ConflictDecision {
  return myId < peerId ? 'keep-outbound' : 'keep-inbound'
}

// ---------------------------------------------------------------------------
// connect 参数校验（facade 委托原生前）
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  /** 发现列表中的对端设备（iOS 用 serviceName/domain 走 .service 端点；Android 用 host:port） */
  peer: DeviceInfo & { serviceName?: string; domain?: string; host?: string }
  /** 本机 deviceId（hello 携带，对端据此竞态判定） */
  myId: string
}

export function validateConnectOptions(options: unknown): asserts options is ConnectOptions {
  if (typeof options !== 'object' || options === null) {
    throw new ChannelProtocolError('connect 参数必须是对象')
  }
  const o = options as Record<string, unknown>
  if (!isNonEmptyString(o.myId)) {
    throw new ChannelProtocolError('myId 必须是非空字符串（本机 deviceId）')
  }
  const peer = o.peer as Record<string, unknown> | null
  if (typeof peer !== 'object' || peer === null) {
    throw new ChannelProtocolError('peer 缺失（发现列表中的设备记录）')
  }
  if (!isNonEmptyString(peer.id)) {
    throw new ChannelProtocolError('peer.id 必须是非空字符串')
  }
  const port = peer.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ChannelProtocolError('peer.port 必须是 1..65535 整数')
  }
  // iOS 端点形态需要 serviceName（发现记录里 Bonjour 服务名）；Android 需要 host
  if (!isNonEmptyString(peer.serviceName) && !isNonEmptyString(peer.host)) {
    throw new ChannelProtocolError('peer 需含 serviceName（iOS 端点）或 host（Android 端点）')
  }
}
