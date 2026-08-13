/**
 * 信令协议消息类型（SPEC §5.2）—— 前端与 server/ 共用。
 *
 * 单协议双载体：WS 与 QR 共用同一个 signal.payload 结构（§5.1）；
 * 在线 WS 中 sdp 明文传输，离线 QR 才压缩（§5.3）。
 */

export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'other'

export interface DeviceInfo {
  id: string
  name: string
  kind: DeviceKind
}

/** presence 中的设备条目（不含敏感字段） */
export interface PeerInfo {
  id: string
  name: string
  kind: DeviceKind
}

export interface SignalPayload {
  kind: 'offer' | 'answer'
  sdp: string
}

/** 客户端 → 服务端 */
export type ClientMessage =
  | { type: 'join'; room: string; device: DeviceInfo }
  | { type: 'leave' }
  | { type: 'signal'; to: string; payload: SignalPayload }

/** 服务端 → 客户端 */
export type ServerMessage =
  | { type: 'room_state'; peers: PeerInfo[] }
  | { type: 'peer_joined'; peer: PeerInfo }
  | { type: 'peer_left'; peerId: string }
  | { type: 'signal'; from: string; payload: SignalPayload }
  | { type: 'error'; reason: string }
