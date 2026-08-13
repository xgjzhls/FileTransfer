/**
 * SignalingClient —— 信令 WS 客户端（SPEC §5.2）。
 *
 * 与协议类型同目录（src/signaling/），把 ServerMessage 路由到事件回调；
 * socket 抽象可注入（测试用假 socket，浏览器用 WebSocket 适配器）。
 */

import type { ClientMessage, DeviceInfo, PeerInfo, ServerMessage, SignalPayload } from '../protocol/signaling'

export type SignalingEvent = 'open' | 'message' | 'close' | 'error'

export interface SignalingSocket {
  send(data: string): void
  close(): void
  on(event: SignalingEvent, handler: (data?: string) => void): void
}

export interface SignalingEvents {
  onRoomState(peers: PeerInfo[]): void
  onPeerJoined(peer: PeerInfo): void
  onPeerLeft(peerId: string): void
  onSignal(from: string, payload: SignalPayload): void
  onError(reason: string): void
}

export class SignalingClient {
  private readonly socket: SignalingSocket
  private readonly events: SignalingEvents

  constructor(socket: SignalingSocket, events: SignalingEvents) {
    this.socket = socket
    this.events = events
    socket.on('message', (data) => this.route(data ?? ''))
  }

  join(room: string, device: DeviceInfo): void {
    this.socket.send(JSON.stringify({ type: 'join', room, device } satisfies ClientMessage))
  }

  leave(): void {
    this.socket.send(JSON.stringify({ type: 'leave' } satisfies ClientMessage))
  }

  signal(to: string, payload: SignalPayload): void {
    this.socket.send(JSON.stringify({ type: 'signal', to, payload } satisfies ClientMessage))
  }

  close(): void {
    this.socket.close()
  }

  private route(raw: string): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw) as ServerMessage
    } catch {
      return // 非法 JSON：忽略
    }
    switch (msg.type) {
      case 'room_state':
        this.events.onRoomState(msg.peers)
        break
      case 'peer_joined':
        this.events.onPeerJoined(msg.peer)
        break
      case 'peer_left':
        this.events.onPeerLeft(msg.peerId)
        break
      case 'signal':
        this.events.onSignal(msg.from, msg.payload)
        break
      case 'error':
        this.events.onError(msg.reason)
        break
    }
  }
}

/** 浏览器 WebSocket 适配器 */
export function createBrowserSocket(url: string): SignalingSocket {
  const ws = new WebSocket(url)
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (event, handler) => {
      if (event === 'message') ws.onmessage = (e) => handler(String(e.data))
      else if (event === 'open') ws.onopen = () => handler()
      else if (event === 'close') ws.onclose = () => handler()
      else ws.onerror = () => handler()
    },
  }
}
