/**
 * RtcPeer —— RTCPeerConnection 封装（SPEC §3.3 连接状态机）。
 *
 * 单次装载信令（§5.3）：等 icegatheringstatechange == complete 后
 * 取 localDescription.sdp，gzip+b64 —— WS 与 QR（T07）共用同一 payload。
 * pcFactory 可注入（单测用假 pc；生产默认浏览器实现）。
 *
 * 数据面：局域网直连，无 STUN/TURN（v1 无跨网需求，CONTEXT 约束）。
 */

import { compressSdp, decompressSdp } from './sdpCodec'

export type PeerState = 'idle' | 'signaling' | 'connecting' | 'connected' | 'disconnected' | 'failed'

export interface RtcPeerEvents {
  onState(state: PeerState): void
  onDataMessage(data: string | ArrayBuffer): void
}

export interface RtcPeerLike {
  createOffer(): Promise<string>
  acceptOffer(encodedOffer: string): Promise<string>
  acceptAnswer(encodedAnswer: string): Promise<void>
  sendData(data: string | Uint8Array): void
  close(): void
  readonly state: PeerState
  readonly bufferedAmount: number
  /** 等待 DataChannel open（发送前调用，避免首帧被丢） */
  waitChannel(timeoutMs?: number): Promise<void>
}

const GATHER_TIMEOUT_MS = 20_000

export function defaultPcFactory(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: [] })
}

export class RtcPeer implements RtcPeerLike {
  private readonly events: RtcPeerEvents
  private readonly pc: RTCPeerConnection
  private dc: RTCDataChannel | null = null
  private _state: PeerState = 'idle'
  private channelOpenPromise: Promise<void> | null = null
  private resolveChannelOpen: (() => void) | null = null

  constructor(events: RtcPeerEvents, pcFactory: () => RTCPeerConnection = defaultPcFactory) {
    this.events = events
    this.pc = pcFactory()
    this.pc.onconnectionstatechange = () => this.handleConnState(this.pc.connectionState)
    this.pc.ondatachannel = (e) => this.attachChannel(e.channel)
  }

  get state(): PeerState {
    return this._state
  }

  /** DataChannel 待发送字节数（Sender 背压用，SPEC §3.1） */
  get bufferedAmount(): number {
    return this.dc?.bufferedAmount ?? 0
  }

  /** 等待 DataChannel open；发送前 await，避免 meta/chunk 首帧丢失 */
  async waitChannel(timeoutMs: number = 10_000): Promise<void> {
    if (this.dc?.readyState === 'open') return
    if (!this.channelOpenPromise) {
      this.channelOpenPromise = new Promise((resolve) => {
        this.resolveChannelOpen = resolve
      })
    }
    await Promise.race([
      this.channelOpenPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('data channel open timeout')), timeoutMs),
      ),
    ])
  }

  async createOffer(): Promise<string> {
    this.setState('signaling')
    const dc = this.pc.createDataChannel('lt', { ordered: true })
    this.attachChannel(dc)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    await waitForGatheringComplete(this.pc)
    if (!this.pc.localDescription) throw new Error('no local description after gathering')
    return compressSdp(this.pc.localDescription.sdp)
  }

  async acceptOffer(encodedOffer: string): Promise<string> {
    this.setState('signaling')
    const sdp = await decompressSdp(encodedOffer)
    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    await waitForGatheringComplete(this.pc)
    if (!this.pc.localDescription) throw new Error('no local description after gathering')
    return compressSdp(this.pc.localDescription.sdp)
  }

  async acceptAnswer(encodedAnswer: string): Promise<void> {
    const sdp = await decompressSdp(encodedAnswer)
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
  }

  sendData(data: string | Uint8Array): void {
    if (!this.dc || this.dc.readyState !== 'open') throw new Error('data channel not open')
    if (typeof data === 'string') {
      this.dc.send(data)
    } else {
      this.dc.send(data as unknown as ArrayBufferView<ArrayBuffer>)
    }
  }

  close(): void {
    try {
      this.dc?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc.close()
    } catch {
      /* ignore */
    }
    this.setState('idle')
  }

  private attachChannel(dc: RTCDataChannel): void {
    this.dc = dc
    // 二进制统一收 ArrayBuffer（默认 binaryType 'blob' 会让 new Uint8Array(e.data) 失败）
    dc.binaryType = 'arraybuffer'
    dc.onmessage = (e) => this.events.onDataMessage(e.data as string | ArrayBuffer)
    dc.onopen = () => this.resolveChannelOpen?.()
  }

  private handleConnState(conn: RTCPeerConnectionState): void {
    switch (conn) {
      case 'connecting':
        this.setState('connecting')
        break
      case 'connected':
        this.setState('connected')
        break
      case 'disconnected':
        this.setState('disconnected')
        break
      case 'failed':
        this.setState('failed')
        break
      case 'closed':
        this.setState('idle')
        break
    }
  }

  private setState(state: PeerState): void {
    if (state === this._state) return
    this._state = state
    this.events.onState(state)
  }
}

async function waitForGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      // icegatheringstatechange 在 new→gathering 时也会触发——必须等 complete
      // 否则 sdp 里还没有 candidate 就发出去
      if (pc.iceGatheringState !== 'complete') return
      pc.onicegatheringstatechange = null
      if (timer) clearTimeout(timer)
      resolve()
    }
    pc.onicegatheringstatechange = done
    // 兜底：STUN 挂起时不能无限等（本地 host candidate 通常即时）
    timer = setTimeout(() => {
      pc.onicegatheringstatechange = null
      resolve() // 即使未 complete 也返回（sdp 可能缺候选，但避免挂死）
    }, GATHER_TIMEOUT_MS)
  })
}
