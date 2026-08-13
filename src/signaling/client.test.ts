import { describe, expect, it } from 'vitest'
import { SignalingClient } from './client'
import type { SignalingEvents, SignalingSocket } from './client'
import type { PeerInfo, SignalPayload } from '../protocol/signaling'

function fakeSocket(): SignalingSocket & {
  sent: string[]
  closed: boolean
  fire: (ev: 'open' | 'message' | 'close' | 'error', data?: string) => void
} {
  const handlers: Record<string, (data?: string) => void> = {}
  const socket: SignalingSocket & {
    sent: string[]
    closed: boolean
    fire: (ev: 'open' | 'message' | 'close' | 'error', data?: string) => void
  } = {
    sent: [],
    closed: false,
    send(data: string) {
      this.sent.push(data)
    },
    close() {
      this.closed = true
    },
    on(ev: 'open' | 'message' | 'close' | 'error', handler: (data?: string) => void) {
      handlers[ev] = handler
    },
    fire(ev: 'open' | 'message' | 'close' | 'error', data?: string) {
      handlers[ev]?.(data)
    },
  }
  return socket
}

function setup() {
  const socket = fakeSocket()
  const roomStates: PeerInfo[][] = []
  const joined: PeerInfo[] = []
  const left: string[] = []
  const signals: [string, SignalPayload][] = []
  const errors: string[] = []
  const events: SignalingEvents = {
    onRoomState: (peers) => roomStates.push(peers),
    onPeerJoined: (peer) => joined.push(peer),
    onPeerLeft: (id) => left.push(id),
    onSignal: (from, payload) => signals.push([from, payload]),
    onError: (reason) => errors.push(reason),
  }
  const client = new SignalingClient(socket, events)
  return { socket, roomStates, joined, left, signals, errors, client }
}

const DEVICE = { id: 'dev-1', name: '我的 iPhone', kind: 'phone' as const }

describe('SignalingClient — 发送（SPEC §5.2 客户端消息）', () => {
  it('join 发送 {type:join, room, device}', () => {
    const { socket, client } = setup()
    client.join('K7Q2', DEVICE)
    expect(socket.sent).toEqual([JSON.stringify({ type: 'join', room: 'K7Q2', device: DEVICE })])
  })

  it('signal 发送 {type:signal, to, payload}', () => {
    const { socket, client } = setup()
    const payload: SignalPayload = { kind: 'offer', sdp: 'v=0...' }
    client.signal('dev-2', payload)
    expect(socket.sent).toEqual([JSON.stringify({ type: 'signal', to: 'dev-2', payload })])
  })

  it('leave 发送 {type:leave}；close 关闭底层 socket', () => {
    const { socket, client } = setup()
    client.leave()
    client.close()
    expect(socket.sent).toEqual([JSON.stringify({ type: 'leave' })])
    expect(socket.closed).toBe(true)
  })
})

describe('SignalingClient — 接收路由（SPEC §5.2 服务端消息）', () => {
  it('room_state → onRoomState(peers)', () => {
    const { socket, roomStates, client } = setup()
    void client
    socket.fire(
      'message',
      JSON.stringify({ type: 'room_state', peers: [{ id: 'a', name: 'A', kind: 'phone' }] }),
    )
    expect(roomStates).toEqual([[{ id: 'a', name: 'A', kind: 'phone' }]])
  })

  it('peer_joined → onPeerJoined；peer_left → onPeerLeft', () => {
    const { socket, joined, left } = setup()
    socket.fire(
      'message',
      JSON.stringify({ type: 'peer_joined', peer: { id: 'b', name: 'B', kind: 'desktop' } }),
    )
    socket.fire('message', JSON.stringify({ type: 'peer_left', peerId: 'b' }))
    expect(joined).toEqual([{ id: 'b', name: 'B', kind: 'desktop' }])
    expect(left).toEqual(['b'])
  })

  it('signal → onSignal(from, payload)', () => {
    const { socket, signals } = setup()
    const payload: SignalPayload = { kind: 'answer', sdp: 'a=...' }
    socket.fire('message', JSON.stringify({ type: 'signal', from: 'a', payload }))
    expect(signals).toEqual([['a', payload]])
  })

  it('error → onError(reason)', () => {
    const { socket, errors } = setup()
    socket.fire('message', JSON.stringify({ type: 'error', reason: 'room full' }))
    expect(errors).toEqual(['room full'])
  })

  it('非法 JSON 静默忽略，不触发事件', () => {
    const { socket, roomStates, errors } = setup()
    socket.fire('message', 'not json{{{')
    expect(roomStates).toEqual([])
    expect(errors).toEqual([])
  })
})
