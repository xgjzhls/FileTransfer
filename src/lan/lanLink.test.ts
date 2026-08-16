/**
 * T05 接线契约集成测试（ADR-0009 分支 A：信令→PC 的接线）。
 *
 * 用两个「模拟设备」（LanDiscoverySession + ConnectionManager + FakeRtc）走通
 * Home.tsx 中的接线规则（即 T05 的重点）：
 * - 点选设备 → native connect → peerConnected(initiator) → 本端建 offer 经原生通道发出
 * - 对端 peerConnected(receiver) → 等 offer → handleOffer 回 answer
 * - 双向均可发起（验收 2）；SDP 经原生通道往返后双方 RtcPeer 收敛
 * - 通道未建立时发 signal → NOT_CONNECTED（Home 静默忽略，等待收敛）
 */
import { describe, expect, it } from 'vitest'
import { LanDiscoverySession } from './lanSession'
import type { LanTransport } from './lanSession'
import { ConnectionManager } from '../webrtc/connection'
import type { ConnectionEvents } from '../webrtc/connection'
import type { RtcPeerEvents, RtcPeerLike } from '../webrtc/peer'
import type { SignalPayload } from '../protocol/signaling'
import type { LanDevice, PeerConnectedEvent, SignalKind, TrackedDevice } from 'lan-discovery'
import type { LanEventData } from './lanSession'

// ── FakeRtc：与 connection.test.ts 同一最小实现 ──

class FakeRtc implements RtcPeerLike {
  createOfferCalls = 0
  acceptOfferCalls = 0
  acceptAnswerCalls = 0
  offerSdp = ''
  answerSdp = ''
  closed = false
  bufferedAmount = 0
  events: RtcPeerEvents

  constructor(events: RtcPeerEvents) {
    this.events = events
  }

  async createOffer(): Promise<string> {
    this.createOfferCalls++
    return 'compressed-offer'
  }
  async acceptOffer(sdp: string): Promise<string> {
    this.acceptOfferCalls++
    this.offerSdp = sdp
    return 'compressed-answer'
  }
  async acceptAnswer(sdp: string): Promise<void> {
    this.acceptAnswerCalls++
    this.answerSdp = sdp
  }
  sendData(_data: string | Uint8Array): void {}
  async waitChannel(_timeoutMs?: number): Promise<void> {}
  onBufferedAmountLow(_cb: () => void): () => void {
    return () => {}
  }
  close(): void {
    this.closed = true
  }
  get state() {
    return 'idle' as const
  }
}

// ── 假原生通道：connect 双端 peerConnected；signal 帧送达对端 messageReceived ──

class FakeChannel implements LanTransport {
  /** 对端 stub（sendMessage 时向其注入 messageReceived） */
  peer: FakeChannel | null = null
  /** 本端 deviceId（帧 from 字段） */
  fromId = ''
  listeners = new Map<string, Array<(e: LanEventData) => void>>()
  /** 会话 activeChannels 模拟：connect 后双端建通 */
  connected = false

  async startSignalingServer(): Promise<{ ok: boolean; port: number }> {
    return { ok: true, port: 8443 }
  }
  async stopSignalingServer(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async startBrowsing(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async stopBrowsing(): Promise<{ ok: boolean }> {
    return { ok: true }
  }

  async connect(_options: { peer: LanDevice; myId: string }): Promise<{ ok: boolean }> {
    // 模拟原生：双端通道建立。拨号方（本端）出向存活 → initiator；对端入向 → receiver
    // （竞态消解规则见 channel.ts / 原生实现，这里只覆盖无竞态主路径）。
    const sessionId = `s-${Date.now()}-${Math.random()}`
    this.connected = true
    this.peer!.connected = true
    this.emit('peerConnected', { id: this.peer!.fromId, session: sessionId, role: 'initiator' })
    this.peer!.emit('peerConnected', { id: this.fromId, session: sessionId, role: 'receiver' })
    return { ok: true }
  }

  async disconnect(): Promise<{ ok: boolean }> {
    this.connected = false
    return { ok: true }
  }

  async sendMessage(options: { peerId: string; kind: SignalKind; sdp: string }): Promise<{ ok: boolean; error?: string }> {
    // 帧送达对端（原生语义：TCP 已建立才可发）
    if (!this.connected) return { ok: false, error: 'NOT_CONNECTED' }
    this.peer!.emit('messageReceived', {
      from: this.fromId,
      session: 's',
      kind: options.kind,
      sdp: options.sdp,
    })
    return { ok: true }
  }

  async addListener(eventName: string, listener: (e: LanEventData) => void): Promise<{ remove(): void }> {
    const arr = this.listeners.get(eventName) ?? []
    arr.push(listener)
    this.listeners.set(eventName, arr)
    return {
      remove: () => {
        const i = arr.indexOf(listener)
        if (i >= 0) arr.splice(i, 1)
      },
    }
  }

  emit(eventName: string, data: LanEventData): void {
    for (const l of this.listeners.get(eventName) ?? []) l(data)
  }
}

// ── 一侧设备：session + manager + 接线规则（复刻 Home.tsx handlers）──

interface Side {
  id: string
  session: LanDiscoverySession
  manager: ConnectionManager
  channel: FakeChannel
  states: string[]
  data: Array<string | ArrayBuffer>
  /** 本侧创建的 RtcPeer（按创建序；last 为当前活跃） */
  rtcs: FakeRtc[]
}

const NOOP = () => {}

function makeSide(id: string): Side {
  const channel = new FakeChannel()
  channel.fromId = id
  const states: string[] = []
  const data: Array<string | ArrayBuffer> = []
  const rtcs: FakeRtc[] = []
  let manager: ConnectionManager | null = null

  const session = new LanDiscoverySession({
    transport: channel,
    device: { name: id, id, kind: 'phone', port: 8443, ver: '1' },
    events: {
      // 接线规则 1：peerConnected(initiator) → 建 offer；receiver → 等 offer
      onPeerConnected: (e: PeerConnectedEvent) => {
        if (e.role === 'initiator') void manager?.connectTo(e.id).catch(NOOP)
      },
      // 接线规则 2：offer → handleOffer；answer → handleAnswer
      onSignal: (from: string, payload: SignalPayload) => {
        if (payload.kind === 'offer') void manager?.handleOffer(from, payload).catch(NOOP)
        else void manager?.handleAnswer(payload).catch(NOOP)
      },
      onDevicesChanged: NOOP,
      onPeerDisconnected: NOOP,
      onServerChange: NOOP,
      onPermissionDenied: NOOP,
      onError: NOOP,
    },
    pruneIntervalMs: 10_000_000,
  })

  const events: ConnectionEvents = {
    onState: (s) => states.push(`${id}:${s}`),
    onData: (d) => data.push(d),
    onError: () => {},
  }
  manager = new ConnectionManager(
    { signal: (to, payload) => void session.sendSignal(to, payload) },
    events,
    (rtcEvents) => {
      const rtc = new FakeRtc(rtcEvents)
      rtcs.push(rtc)
      return rtc
    },
  )
  return { id, session, manager, channel, states, data, rtcs }
}

async function makeLinkedPair(aId: string, bId: string): Promise<[Side, Side]> {
  const a = makeSide(aId)
  const b = makeSide(bId)
  a.channel.peer = b.channel
  b.channel.peer = a.channel
  await a.session.start()
  await b.session.start()
  return [a, b]
}

function latestRtc(side: Side): FakeRtc {
  return side.rtcs.at(-1)!
}

const devB: TrackedDevice = {
  name: 'B', id: 'bbbb2222', kind: 'phone', port: 8443, ver: '1',
  serviceName: 'bbbb2222', domain: 'local.', firstSeen: 0, lastSeen: 0,
}
const devA: TrackedDevice = {
  name: 'A', id: 'aaaa1111', kind: 'phone', port: 8443, ver: '1',
  serviceName: 'aaaa1111', domain: 'local.', firstSeen: 0, lastSeen: 0,
}

describe('T05 接线：局域网点选连接 → 原生信令 → WebRTC 握手', () => {
  it('A 点选 B：A 建 offer 经原生通道 → B 回 answer → A 收 answer（双方 RtcPeer 收敛）', async () => {
    const [a, b] = await makeLinkedPair('aaaa1111', 'bbbb2222')
    const r = await a.session.connectTo(devB)
    expect(r).toEqual({ ok: true })

    // 接线：A(initiator) 建 offer → session.sendSignal → 原生帧 → B messageReceived
    const aRtc = latestRtc(a)
    expect(aRtc.createOfferCalls).toBe(1)
    // B(receiver) 收到 offer → handleOffer 回 answer → 帧回 A
    const bRtc = latestRtc(b)
    expect(bRtc.acceptOfferCalls).toBe(1)
    expect(bRtc.offerSdp).toBe('compressed-offer')
    // A 收到 answer 并应用
    expect(aRtc.acceptAnswerCalls).toBe(1)
    expect(aRtc.answerSdp).toBe('compressed-answer')

    // 数据面互通（模拟 DataChannel 事件与 sendData）
    aRtc.events.onState('connected')
    bRtc.events.onState('connected')
    expect(a.states).toContain('aaaa1111:connected')
    expect(b.states).toContain('bbbb2222:connected')
  })

  it('B 点选 A：对称流程（验收 2：双向均可发起）', async () => {
    const [a, b] = await makeLinkedPair('aaaa1111', 'bbbb2222')
    const r = await b.session.connectTo(devA)
    expect(r).toEqual({ ok: true })

    const bRtc = latestRtc(b)
    expect(bRtc.createOfferCalls).toBe(1) // B 是 offer 方
    const aRtc = latestRtc(a)
    expect(aRtc.acceptOfferCalls).toBe(1) // A 是 answer 方
    expect(aRtc.offerSdp).toBe('compressed-offer')
    expect(bRtc.acceptAnswerCalls).toBe(1)
    expect(bRtc.answerSdp).toBe('compressed-answer')
  })

  it('通道未建立时发 signal → NOT_CONNECTED（Home 静默忽略，等 peerConnected 收敛）', async () => {
    const [a] = await makeLinkedPair('aaaa1111', 'bbbb2222')
    const r = await a.session.sendSignal('bbbb2222', { kind: 'offer', sdp: 'x' })
    expect(r).toEqual({ ok: false, error: 'NOT_CONNECTED' })
  })

  it('握手前通道断开 → sendMessage 拒绝（NOT_CONNECTED），重建后可继续', async () => {
    const [a, b] = await makeLinkedPair('aaaa1111', 'bbbb2222')
    await a.session.connectTo(devB)
    // 原生通道断开（对端消失）：双端 connected 复位
    a.channel.connected = false
    b.channel.connected = false
    const r = await a.session.sendSignal('bbbb2222', { kind: 'offer', sdp: 'x' })
    expect(r).toEqual({ ok: false, error: 'NOT_CONNECTED' })
  })
})
