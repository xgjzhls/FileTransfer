import { describe, expect, it } from 'vitest'
import { RtcPeer } from './peer'
import { decompressSdp } from './sdpCodec'
import type { RtcPeerEvents } from './peer'

/** 假 RTCPeerConnection：记录调用、可手动触发事件（系统边界 mock） */
class FakeDc {
  readyState: RTCDataChannelState = 'open'
  sent: Array<string | ArrayBuffer> = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  send(data: string | ArrayBuffer) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 'closed'
  }
}

class FakePc {
  connectionState: RTCPeerConnectionState = 'new'
  iceGatheringState: RTCIceGatheringState = 'complete'
  localDescription: RTCSessionDescription | null = null
  remoteDescription: RTCSessionDescription | null = null
  channel: FakeDc | null = null
  channelLabel = ''
  channelOptions: RTCDataChannelInit | null = null
  onconnectionstatechange: (() => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  ondatachannel: ((e: RTCDataChannelEvent) => void) | null = null

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    this.channelLabel = label
    this.channelOptions = options ?? null
    this.channel = new FakeDc()
    return this.channel as unknown as RTCDataChannel
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'offer-sdp-literal' }
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: 'answer-sdp-literal' }
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc as RTCSessionDescription
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc as RTCSessionDescription
  }
  async close() {
    this.connectionState = 'closed'
  }

  triggerConnState(state: RTCPeerConnectionState) {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
  triggerGatheringComplete() {
    this.iceGatheringState = 'complete'
    this.onicegatheringstatechange?.()
  }
  triggerChannel() {
    this.channel ??= new FakeDc()
    this.ondatachannel?.({ channel: this.channel } as unknown as RTCDataChannelEvent)
  }
}

function setup() {
  const pc = new FakePc()
  const states: string[] = []
  const data: Array<string | ArrayBuffer> = []
  const events: RtcPeerEvents = {
    onState: (s) => states.push(s),
    onDataMessage: (d) => data.push(d),
  }
  const peer = new RtcPeer(events, () => pc as unknown as RTCPeerConnection)
  return { pc, peer, states, data }
}

describe('RtcPeer — offer 端', () => {
  it('createOffer：DataChannel ordered:true + label lt，gathering complete 后返回压缩 sdp', async () => {
    const { pc, peer } = setup()
    const encoded = await peer.createOffer()
    expect(pc.channelLabel).toBe('lt')
    expect(pc.channelOptions).toEqual({ ordered: true })
    expect(pc.localDescription?.type).toBe('offer')
    expect(await decompressSdp(encoded)).toBe('offer-sdp-literal')
  })

  it('gathering 未完成时 createOffer 挂起，完成后才 resolve', async () => {
    const { pc, peer } = setup()
    pc.iceGatheringState = 'gathering'
    let settled = false
    const pending = peer.createOffer().then(() => {
      settled = true
      return null
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    pc.triggerGatheringComplete()
    await pending
    expect(settled).toBe(true)
  })

  it('状态：createOffer 置 signaling；pc connected → onState(connected)', async () => {
    const { pc, peer, states } = setup()
    await peer.createOffer()
    expect(states[0]).toBe('signaling')
    pc.triggerConnState('connecting')
    expect(states).toContain('connecting')
    pc.triggerConnState('connected')
    expect(states.at(-1)).toBe('connected')
  })
})

describe('RtcPeer — answer 端', () => {
  it('acceptOffer：解压 sdp 设 remote offer，返回压缩 answer', async () => {
    const { pc, peer } = setup()
    const { compressSdp } = await import('./sdpCodec')
    const encodedOffer = await compressSdp('offer-from-peer')
    const encodedAnswer = await peer.acceptOffer(encodedOffer)
    expect(pc.remoteDescription?.type).toBe('offer')
    expect(pc.remoteDescription?.sdp).toBe('offer-from-peer')
    expect(pc.localDescription?.type).toBe('answer')
    expect(await decompressSdp(encodedAnswer)).toBe('answer-sdp-literal')
  })

  it('acceptAnswer：解压 sdp 设 remote answer', async () => {
    const { pc, peer } = setup()
    const { compressSdp } = await import('./sdpCodec')
    await peer.acceptAnswer(await compressSdp('answer-from-peer'))
    expect(pc.remoteDescription?.type).toBe('answer')
    expect(pc.remoteDescription?.sdp).toBe('answer-from-peer')
  })
})

describe('RtcPeer — DataChannel 数据与失败状态', () => {
  it('ondatachannel 注册后 sendData 可用', async () => {
    const { pc, peer, data } = setup()
    pc.triggerChannel()
    peer.sendData('hello')
    expect(pc.channel!.sent).toEqual(['hello'])
    pc.channel!.onmessage?.({ data: 'echo' })
    expect(data).toEqual(['echo'])
  })

  it('DataChannel 未开时 sendData 抛错', () => {
    const { pc, peer } = setup()
    pc.triggerChannel()
    pc.channel!.readyState = 'connecting'
    expect(() => peer.sendData('x')).toThrow(/not open/)
  })

  it('pc failed → onState(failed)', () => {
    const { pc, states } = setup()
    pc.triggerConnState('failed')
    expect(states.at(-1)).toBe('failed')
  })
})
