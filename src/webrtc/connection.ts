/**
 * ConnectionManager —— 握手编排（SPEC §3.3 状态机 / §3.4 握手）。
 *
 * 把 SignalingClient 事件与 RtcPeer 串起来：点选设备 → offer；
 * 收到 offer → 自动回 answer；answer → connected。DataChannel 数据
 * 原样透传（T05 由 TransferController 做 framing/解析）。
 *
 * rtcFactory 接收 RtcPeerEvents（构造注入，便于单测 / UI 解耦）。
 */

import type { SignalPayload } from '../protocol/signaling'
import type { RtcPeerEvents, RtcPeerLike } from './peer'

export interface SignalLike {
  signal(to: string, payload: SignalPayload): void
}

export interface ConnectionEvents {
  onState(state: string): void
  /** DataChannel 原始数据（T05：framing 后的 control/chunk） */
  onData(data: string | ArrayBuffer): void
  onError(reason: string): void
}

export class ConnectionManager {
  private readonly signal: SignalLike
  private readonly events: ConnectionEvents
  private readonly rtcFactory: (events: RtcPeerEvents) => RtcPeerLike
  private peer: RtcPeerLike | null = null

  constructor(
    signal: SignalLike,
    events: ConnectionEvents,
    rtcFactory: (events: RtcPeerEvents) => RtcPeerLike,
  ) {
    this.signal = signal
    this.events = events
    this.rtcFactory = rtcFactory
  }

  /** 点选设备：本端为 offer 端（创建 DataChannel + offer） */
  async connectTo(peerId: string): Promise<void> {
    const rtc = this.newPeer()
    const sdp = await rtc.createOffer()
    this.signal.signal(peerId, { kind: 'offer', sdp })
  }

  /** 收到对方 offer：本端为 answer 端，自动回 answer */
  async handleOffer(from: string, payload: SignalPayload): Promise<void> {
    const rtc = this.newPeer()
    const sdp = await rtc.acceptOffer(payload.sdp)
    this.signal.signal(from, { kind: 'answer', sdp })
  }

  /** 收到对方 answer */
  async handleAnswer(payload: SignalPayload): Promise<void> {
    await this.peer?.acceptAnswer(payload.sdp)
  }

  /** DataChannel 待发送字节数（Sender 背压） */
  get bufferedAmount(): number {
    return this.peer?.bufferedAmount ?? 0
  }

  /** 经 DataChannel 发送原始数据（帧由调用方构造：encodeControl/encodeChunk） */
  sendData(data: string | Uint8Array): void {
    try {
      this.peer?.sendData(data)
    } catch {
      this.events.onError('data channel not open')
    }
  }

  /** 等待 DataChannel open（发送前调用） */
  async waitChannel(timeoutMs?: number): Promise<void> {
    if (this.peer) await this.peer.waitChannel(timeoutMs)
  }

  close(): void {
    this.peer?.close()
    this.peer = null
  }

  private newPeer(): RtcPeerLike {
    this.peer?.close()
    const rtc = this.rtcFactory({
      onState: (s) => this.events.onState(s),
      onDataMessage: (d) => this.events.onData(d),
    })
    this.peer = rtc
    return rtc
  }
}
