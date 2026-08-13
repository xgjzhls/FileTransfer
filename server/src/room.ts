/**
 * RoomCore —— 房间状态机（纯逻辑，不依赖 Cloudflare API，可单测）。
 *
 * 职责：presence 维护、join 幂等、房间上限、signal 转发、leave 广播。
 * Durable Object（Room）只是薄壳：把 WebSocket 事件喂给本类，
 * 并按其输出发送消息 + 管理过期 alarm。
 *
 * 消息格式遵循 SPEC §5.2。
 */

import type { DeviceInfo, PeerInfo, ServerMessage, SignalPayload } from '../../src/protocol/signaling'

export type { DeviceInfo, ServerMessage } from '../../src/protocol/signaling'

/** 连接抽象：DO 壳用 WebSocket 实现 */
export interface PeerConnection {
  send(message: ServerMessage): void
  close(code?: number, reason?: string): void
}

export type JoinResult = { kind: 'joined' } | { kind: 'rejoined' } | { kind: 'full' }
export type LeaveResult = { kind: 'left' } | { kind: 'noop' }
export type SignalResult = { kind: 'forwarded' } | { kind: 'error' }

interface Peer {
  info: PeerInfo
  conn: PeerConnection
}

export class RoomCore {
  private readonly peers = new Map<string, Peer>()
  private readonly maxPeers: number

  constructor(maxPeers: number) {
    this.maxPeers = maxPeers
  }

  /**
   * join：新设备 → 广播 peer_joined + 给加入者 room_state；
   * 同 deviceId 重连 → 替换连接（幂等，不广播），刷新 room_state；
   * 房间满 → error + 关闭连接。
   */
  join(device: DeviceInfo, conn: PeerConnection): JoinResult {
    const existing = this.peers.get(device.id)
    if (existing) {
      existing.conn.close()
      existing.info = { id: device.id, name: device.name, kind: device.kind }
      existing.conn = conn
      conn.send({ type: 'room_state', peers: this.peerInfos() })
      return { kind: 'rejoined' }
    }
    if (this.peers.size >= this.maxPeers) {
      conn.send({ type: 'error', reason: 'room full' })
      conn.close(4004, 'room full')
      return { kind: 'full' }
    }
    const info: PeerInfo = { id: device.id, name: device.name, kind: device.kind }
    this.peers.set(device.id, { info, conn })
    for (const [id, peer] of this.peers) {
      if (id !== device.id) peer.conn.send({ type: 'peer_joined', peer: info })
    }
    conn.send({ type: 'room_state', peers: this.peerInfos() })
    return { kind: 'joined' }
  }

  /** leave：向其余设备广播 peer_left；不存在的 leave 无效果 */
  leave(deviceId: string): LeaveResult {
    if (!this.peers.delete(deviceId)) return { kind: 'noop' }
    for (const peer of this.peers.values()) {
      peer.conn.send({ type: 'peer_left', peerId: deviceId })
    }
    return { kind: 'left' }
  }

  /** signal：转发给目标；目标不存在 → 错误回给发送者 */
  signal(from: string, to: string, payload: SignalPayload): SignalResult {
    const sender = this.peers.get(from)
    if (!sender) return { kind: 'error' }
    const target = this.peers.get(to)
    if (!target) {
      sender.conn.send({ type: 'error', reason: 'peer not found' })
      return { kind: 'error' }
    }
    target.conn.send({ type: 'signal', from, payload })
    return { kind: 'forwarded' }
  }

  peerInfos(): PeerInfo[] {
    return [...this.peers.values()].map((peer) => peer.info)
  }

  get size(): number {
    return this.peers.size
  }
}
