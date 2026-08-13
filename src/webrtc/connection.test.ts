import { describe, expect, it } from 'vitest'
import { ConnectionManager } from './connection'
import type { ConnectionEvents } from './connection'
import type { RtcPeerEvents, RtcPeerLike } from './peer'
import type { MetaMessage } from '../protocol/transfer'
import type { SignalPayload } from '../protocol/signaling'

class FakeRtc implements RtcPeerLike {
  static last: FakeRtc | null = null
  createOfferCalls = 0
  acceptOfferCalls = 0
  acceptAnswerCalls = 0
  offerSdp = ''
  answerSdp = ''
  sent: Array<string | ArrayBuffer> = []
  closed = false
  events: RtcPeerEvents

  constructor(events: RtcPeerEvents) {
    this.events = events
    FakeRtc.last = this
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
  sendData(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  get state() {
    return 'idle' as const
  }
}

function setup() {
  const signals: Array<[string, SignalPayload]> = []
  const states: string[] = []
  const metas: MetaMessage[] = []
  const errors: string[] = []
  const events: ConnectionEvents = {
    onState: (s) => states.push(s),
    onMeta: (m) => metas.push(m),
    onError: (r) => errors.push(r),
  }
  const manager = new ConnectionManager(
    { signal: (to, payload) => signals.push([to, payload]) },
    events,
    (rtcEvents) => new FakeRtc(rtcEvents),
  )
  return { manager, signals, states, metas, errors }
}

function latestRtc(): FakeRtc {
  return FakeRtc.last!
}

const OFFER_PAYLOAD: SignalPayload = { kind: 'offer', sdp: 'remote-offer' }
const ANSWER_PAYLOAD: SignalPayload = { kind: 'answer', sdp: 'remote-answer' }

describe('ConnectionManager — 握手流（SPEC §3.3）', () => {
  it('connectTo：创建 offer 并经信令发给目标', async () => {
    const { manager, signals } = setup()
    await manager.connectTo('dev-b')
    const rtc = latestRtc()
    expect(rtc.createOfferCalls).toBe(1)
    expect(signals).toEqual([['dev-b', { kind: 'offer', sdp: 'compressed-offer' }]])
  })

  it('handleOffer：接受 offer 并自动回 answer', async () => {
    const { manager, signals } = setup()
    await manager.handleOffer('dev-a', OFFER_PAYLOAD)
    const rtc = latestRtc()
    expect(rtc.acceptOfferCalls).toBe(1)
    expect(rtc.offerSdp).toBe('remote-offer')
    expect(signals).toEqual([['dev-a', { kind: 'answer', sdp: 'compressed-answer' }]])
  })

  it('handleAnswer：设置远端 answer', async () => {
    const { manager } = setup()
    await manager.connectTo('dev-b')
    await manager.handleAnswer(ANSWER_PAYLOAD)
    expect(latestRtc().answerSdp).toBe('remote-answer')
  })

  it('新连接替换旧连接（旧 peer 被关闭）', async () => {
    const { manager } = setup()
    await manager.connectTo('dev-b')
    const first = latestRtc()
    await manager.handleOffer('dev-a', OFFER_PAYLOAD)
    const second = latestRtc()
    expect(first).not.toBe(second)
    expect(first.closed).toBe(true)
  })

  it('RtcPeer 状态事件透传', async () => {
    const { manager, states } = setup()
    await manager.connectTo('dev-b')
    latestRtc().events.onState('connected')
    expect(states.at(-1)).toBe('connected')
  })
})

describe('ConnectionManager — meta 收发（SPEC §3.2）', () => {
  it('handleData 收到 meta JSON → onMeta', () => {
    const { manager, metas } = setup()
    const meta: MetaMessage = {
      type: 'meta',
      sessionId: 'sess-1',
      files: [{ id: 0, name: 'a.txt', size: 10, parts: [{ index: 0, size: 10, sha256: '' }] }],
    }
    manager.handleData(JSON.stringify(meta))
    expect(metas).toEqual([meta])
  })

  it('handleData 非 JSON / 非 meta / binary 均忽略', () => {
    const { manager, metas } = setup()
    manager.handleData('not json')
    manager.handleData(JSON.stringify({ type: 'part_done' }))
    manager.handleData(new Uint8Array([1, 2, 3]).buffer)
    expect(metas).toEqual([])
  })
})

describe('ConnectionManager — sendMeta 需要活动连接', () => {
  it('connectTo 后 sendMeta 经 peer 发送', async () => {
    const { manager } = setup()
    await manager.connectTo('dev-b')
    const meta: MetaMessage = { type: 'meta', sessionId: 's', files: [] }
    manager.sendMeta(meta)
    expect(latestRtc().sent).toEqual([JSON.stringify(meta)])
  })

  it('close 后无 peer，sendMeta 静默', () => {
    const { manager } = setup()
    manager.close()
    expect(() => manager.sendMeta({ type: 'meta', sessionId: 's', files: [] })).not.toThrow()
  })
})
