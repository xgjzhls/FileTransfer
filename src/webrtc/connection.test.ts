import { beforeEach, describe, expect, it } from 'vitest'
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
  sent: Array<string | Uint8Array> = []
  closed = false
  bufferedAmount = 0
  lowCallback: (() => void) | null = null
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
  sendData(data: string | Uint8Array): void {
    this.sent.push(data)
  }
  async waitChannel(_timeoutMs?: number): Promise<void> {
    /* fake 视为已 open */
  }
  onBufferedAmountLow(cb: () => void): () => void {
    this.lowCallback = cb
    return () => {
      this.lowCallback = null
    }
  }
  close(): void {
    this.closed = true
  }
  get state() {
    return 'idle' as const
  }
}

beforeEach(() => {
  FakeRtc.last = null
})

function setup() {
  const signals: Array<[string, SignalPayload]> = []
  const states: string[] = []
  const data: Array<string | ArrayBuffer> = []
  const errors: string[] = []
  const events: ConnectionEvents = {
    onState: (s) => states.push(s),
    onData: (d) => data.push(d),
    onError: (r) => errors.push(r),
  }
  const manager = new ConnectionManager(
    { signal: (to, payload) => signals.push([to, payload]) },
    events,
    (rtcEvents) => new FakeRtc(rtcEvents),
  )
  return { manager, signals, states, data, errors }
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

describe('ConnectionManager — DataChannel 数据透传', () => {
  it('handleData → onData 原样透传（JSON 字符串与二进制）', async () => {
    const { manager, data } = setup()
    await manager.connectTo('dev-b')
    // 通过 FakeRtc 的事件注入数据
    const rtc = latestRtc()
    rtc.events.onDataMessage('{"type":"meta"}')
    const binary = new Uint8Array([1, 2, 3]).buffer
    rtc.events.onDataMessage(binary)
    expect(data).toEqual(['{"type":"meta"}', binary])
  })

  it('sendData 经 peer 发送；bufferedAmount 透传', async () => {
    const { manager } = setup()
    await manager.connectTo('dev-b')
    const frame = new Uint8Array([0, 1, 2])
    manager.sendData(frame)
    expect(latestRtc().sent).toEqual([frame])
    latestRtc().bufferedAmount = 1024
    expect(manager.bufferedAmount).toBe(1024)
  })

  it('close 后无 peer，sendData 静默不抛', () => {
    const { manager } = setup()
    manager.close()
    expect(() => manager.sendData(new Uint8Array([0]))).not.toThrow()
  })
})

describe('ConnectionManager — sendData 需要活动连接', () => {
  it('connectTo 后 sendData 经 peer 发送', async () => {
    const { manager } = setup()
    await manager.connectTo('dev-b')
    const meta: MetaMessage = { type: 'meta', sessionId: 's', files: [] }
    manager.sendData(JSON.stringify(meta))
    expect(latestRtc().sent).toEqual([JSON.stringify(meta)])
  })
})
