/**
 * 原生信令通道协议（ADR-0009 / T04）JS 侧单测：
 * - 帧编解码（4B 大端长度前缀 + UTF-8 JSON；上限 64 KiB）
 * - 消息构建/校验（hello / signal，schema 与 SPEC §5.1 signal.payload 一致）
 * - 竞态判定（低 deviceId 胜：保留下方发起的连接；两侧独立收敛同一连接）
 * - session token（uuid）与错误码常量
 */
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_ERRORS,
  ChannelProtocolError,
  DEFAULT_SIGNALING_PORT,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  decodeFrame,
  decodeFrameLength,
  encodeFrame,
  makeHello,
  makeSignal,
  newSessionToken,
  resolveChannelConflict,
  validateChannelMessage,
  validateConnectOptions,
  validateSignalPayload,
} from './channel'

describe('帧编解码（wire 格式钉死）', () => {
  it('hello 帧：4B 大端长度前缀 + JSON 载荷，往返一致', () => {
    const msg = makeHello('4f6a3f4c-0c2e-4b8a-9d5f-1e2a3b4c5d6e', 'sess-123')
    const frame = encodeFrame(msg)
    expect(frame.byteLength).toBe(4 + new TextEncoder().encode(JSON.stringify(msg)).byteLength)

    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(dv.getUint32(0, false)).toBe(frame.byteLength - 4) // 大端（false = big-endian）
    expect(decodeFrameLength(frame.subarray(0, 4))).toBe(frame.byteLength - 4)

    const parsed = decodeFrame(frame.subarray(4))
    expect(parsed).toEqual(msg)
  })

  it('signal 帧：gzip+base64url 的 sdp 是透明字符串，不因内容转义而破坏帧边界', () => {
    // 模拟压缩 SDP（base64url 无空白；此处故意混入可复现 JSON 转义问题的字符）
    const sdp = 'v=0\r\no=- 123 2 IN IP4 192.168.1.5\r\na=candidate:1 1 udp 2122260223 192.168.1.5 53610 typ host\r\n'
    const msg = makeSignal('offer', btoa(sdp))
    const frame = encodeFrame(msg)
    const parsed = decodeFrame(frame.subarray(4))
    expect(parsed).toEqual(msg)
    expect((parsed as { kind: string }).kind).toBe('offer')
    expect((parsed as { sdp: string }).sdp).toBe(btoa(sdp))
  })

  it('多字节 UTF-8（中文载荷）长度以字节计，往返一致', () => {
    const msg = makeSignal('answer', '5L2g5aW977yM5LiW55WM')
    const frame = encodeFrame(msg)
    const len = decodeFrameLength(frame.subarray(0, 4))
    expect(len).toBe(new TextEncoder().encode(JSON.stringify(msg)).byteLength)
    expect(decodeFrame(frame.subarray(4))).toEqual(msg)
  })

  it('帧长度超上限（64 KiB）→ FrameTooLargeError（原生侧按协议违规关连接）', () => {
    const tooBig = new Uint8Array(4)
    new DataView(tooBig.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false)
    expect(() => decodeFrameLength(tooBig)).toThrow(FrameTooLargeError)
    expect(() => decodeFrameLength(tooBig)).toThrow(/64/)
    // 恰好上限（含边界）不抛
    const atCap = new Uint8Array(4)
    new DataView(atCap.buffer).setUint32(0, MAX_FRAME_BYTES, false)
    expect(() => decodeFrameLength(atCap)).not.toThrow()
  })

  it('长度前缀不足 4 字节 / 非 JSON 载荷 → ChannelProtocolError', () => {
    expect(() => decodeFrameLength(new Uint8Array([0, 0, 1]))).toThrow(ChannelProtocolError)
    expect(() => decodeFrame(new TextEncoder().encode('not-json'))).toThrow(ChannelProtocolError)
  })
})

describe('消息 schema（与 SPEC §5.1 signal.payload 一致）', () => {
  it('makeHello 产出 v1 hello（id + session）', () => {
    expect(makeHello('dev-1', 'sess-x')).toEqual({ v: 1, type: 'hello', id: 'dev-1', session: 'sess-x' })
  })

  it('makeSignal 产出 v1 signal（kind + sdp），sdp 为压缩字符串', () => {
    expect(makeSignal('answer', 'abc')).toEqual({ v: 1, type: 'signal', kind: 'answer', sdp: 'abc' })
  })

  it('validateChannelMessage 拒绝未知 type / 缺字段 / 坏 kind / 非对象', () => {
    const ok = makeHello('dev-1', 'sess-x')
    expect(() => validateChannelMessage(ok)).not.toThrow()

    expect(() => validateChannelMessage({ v: 1, type: 'bye', id: 'x', session: 's' })).toThrow(ChannelProtocolError)
    expect(() => validateChannelMessage({ v: 1, type: 'hello' })).toThrow(/id/)
    expect(() => validateChannelMessage({ v: 1, type: 'hello', id: 'x' })).toThrow(/session/)
    expect(() => validateChannelMessage({ v: 1, type: 'signal', kind: 'candidate', sdp: 'x' })).toThrow(/kind/)
    expect(() => validateChannelMessage({ v: 1, type: 'signal', kind: 'offer' })).toThrow(/sdp/)
    expect(() => validateChannelMessage('hello')).toThrow(ChannelProtocolError)
    expect(() => validateChannelMessage(null)).toThrow(ChannelProtocolError)
    // 版本不符
    expect(() => validateChannelMessage({ v: 2, type: 'hello', id: 'x', session: 's' })).toThrow(/v/)
  })

  it('validateSignalPayload（facade 在委托原生前拦截）', () => {
    expect(validateSignalPayload('offer', 'x')).toEqual({ v: 1, type: 'signal', kind: 'offer', sdp: 'x' })
    expect(validateSignalPayload('answer', 'x')).toEqual({ v: 1, type: 'signal', kind: 'answer', sdp: 'x' })
    expect(() => validateSignalPayload('offer', '')).toThrow(ChannelProtocolError)
    expect(() => validateSignalPayload('offer', '   ')).toThrow(ChannelProtocolError)
    expect(() => validateSignalPayload('candidate' as never, 'x')).toThrow(/kind/)
  })
})

describe('竞态判定（低 deviceId 胜 → 唯一通道）', () => {
  it('我 id 低于对端 → 保留我的出向（我发起的连接存活）', () => {
    expect(resolveChannelConflict('aaa', 'bbb')).toBe('keep-outbound')
  })

  it('我 id 高于对端 → 保留入向（对端发起的连接存活）', () => {
    expect(resolveChannelConflict('bbb', 'aaa')).toBe('keep-inbound')
  })

  it('两侧独立套同一规则 → 收敛到同一连接（低 id 方的出向）', () => {
    const lowId = '4f6a3f4c-0c2e-4b8a-9d5f-1e2a3b4c5d6e'
    const highId = '9c1e2d34-5678-4abc-9def-0123456789ab'
    // 低 id 方：keep-outbound；高 id 方：keep-inbound —— 同一幸存连接 = 低 id 方发起的连接
    expect(resolveChannelConflict(lowId, highId)).toBe('keep-outbound')
    expect(resolveChannelConflict(highId, lowId)).toBe('keep-inbound')
  })

  it('deviceId 相等（不应发生）→ 保守取 keep-inbound，两端不产生双连接死锁外的不一致', () => {
    // 防御语义：同 id 是部署错误；规则必须确定（不抛、返回固定值）
    expect(resolveChannelConflict('same', 'same')).toBe('keep-inbound')
  })
})

describe('session token 与常量', () => {
  it('newSessionToken 为 uuid 且两次不同', () => {
    const a = newSessionToken()
    const b = newSessionToken()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })

  it('默认端口 8443（SPEC §5.5；PORT_IN_USE 时 JS 依次试后续）', () => {
    expect(DEFAULT_SIGNALING_PORT).toBe(8443)
  })

  it('错误码常量齐备（原生侧与 facade 共用同一词汇表）', () => {
    expect(CHANNEL_ERRORS.PORT_IN_USE).toBe('PORT_IN_USE')
    expect(CHANNEL_ERRORS.CONNECTION_REFUSED).toBe('CONNECTION_REFUSED')
    expect(CHANNEL_ERRORS.CONNECTION_TIMEOUT).toBe('CONNECTION_TIMEOUT')
    expect(CHANNEL_ERRORS.HOST_UNKNOWN).toBe('HOST_UNKNOWN')
    expect(CHANNEL_ERRORS.PEER_MISMATCH).toBe('PEER_MISMATCH') // v1 留位（T04 设计定稿）
    expect(CHANNEL_ERRORS.NOT_CONNECTED).toBe('NOT_CONNECTED')
    expect(CHANNEL_ERRORS.ALREADY_CONNECTING).toBe('ALREADY_CONNECTING')
    expect(CHANNEL_ERRORS.PROTOCOL_VIOLATION).toBe('PROTOCOL_VIOLATION')
    expect(CHANNEL_ERRORS.INVALID_PARAMS).toBe('INVALID_PARAMS')
  })
})

describe('validateConnectOptions（connect 参数防御校验）', () => {
  const peer = {
    id: 'peer-1',
    name: '对端',
    kind: 'phone' as const,
    port: 8443,
    ver: '1',
    serviceName: 'peer-1',
    domain: 'local.',
  }

  it('合法 peer + myId 通过', () => {
    expect(() => validateConnectOptions({ peer, myId: 'me' })).not.toThrow()
  })

  it('缺 myId / peer.id 空 / port 越界 / serviceName 缺失（iOS 需要）拒绝', () => {
    expect(() => validateConnectOptions({ peer, myId: '' })).toThrow(/myId/)
    expect(() => validateConnectOptions({ peer: { ...peer, id: '' }, myId: 'me' })).toThrow(/id/)
    expect(() => validateConnectOptions({ peer: { ...peer, port: 0 }, myId: 'me' })).toThrow(/port/)
    expect(() => validateConnectOptions({ peer: { ...peer, port: 70000 }, myId: 'me' })).toThrow(/port/)
    expect(() => validateConnectOptions({ peer: { ...peer, serviceName: '' }, myId: 'me' })).toThrow(/serviceName/)
  })
})
