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
    dc.onmessage = (e) => this.events.onDataMessage(e.data as string | ArrayBuffer)
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
    const done = () => {
      pc.onicegatheringstatechange = null
      clearTimeout(timer)
      resolve()
    }
    pc.onicegatheringstatechange = done
    // 兜底：STUN 挂起时不能无限等（本地 host candidate 通常即时）
    const timer = setTimeout(done, GATHER_TIMEOUT_MS)
  })
}
