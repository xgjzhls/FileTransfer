import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReconnectingSignalingClient } from './reconnect'
import type { SignalingConnState } from './reconnect'
import type { SignalingEvents, SignalingSocket } from './client'
import type { DeviceInfo, PeerInfo, SignalPayload } from '../protocol/signaling'

/** 可注入的假 socket：记录发送内容、可手动触发事件（模拟真实 WebSocket） */
interface FakeSocket extends SignalingSocket {
  sent: string[]
  closed: boolean
  fire(ev: 'open' | 'message' | 'close' | 'error', data?: string): void
}

function socketHarness() {
  const sockets: FakeSocket[] = []
  const createSocket = (): SignalingSocket => {
    const handlers: Record<string, ((data?: string) => void) | undefined> = {}
    const s: FakeSocket = {
      sent: [],
      closed: false,
      send(data: string) {
        this.sent.push(data)
      },
      close() {
        this.closed = true
      },
      on(ev, handler) {
        handlers[ev] = handler
      },
      fire(ev, data) {
        handlers[ev]?.(data)
      },
    }
    sockets.push(s)
    return s
  }
  return { sockets, createSocket }
}

const URL = 'wss://signaling.local/ws?room=K7Q2'
const ROOM = 'K7Q2'
const DEVICE: DeviceInfo = { id: 'dev-1', name: '我的 iPhone', kind: 'phone' }
const PEER_B: PeerInfo = { id: 'dev-2', name: 'E2E-B', kind: 'desktop' }
const PEER_C: PeerInfo = { id: 'dev-3', name: 'iPad', kind: 'tablet' }

function setup(overrides: Partial<ConstructorParameters<typeof ReconnectingSignalingClient>[0]> = {}) {
  const { sockets, createSocket } = socketHarness()
  const states: SignalingConnState[] = []
  const roomStates: PeerInfo[][] = []
  const gaveUp = { count: 0 }
  const events: SignalingEvents = {
    onRoomState: (peers) => roomStates.push(peers),
    onPeerJoined: () => {},
    onPeerLeft: () => {},
    onSignal: () => {},
    onError: () => {},
  }
  const client = new ReconnectingSignalingClient({
    createSocket,
    events,
    onState: (s) => states.push(s),
    onGaveUp: () => {
      gaveUp.count++
    },
    ...overrides,
  })
  return { sockets, client, states, roomStates, gaveUp }
}

function joinMsg(room: string = ROOM, device: DeviceInfo = DEVICE) {
  return JSON.stringify({ type: 'join', room, device })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ReconnectingSignalingClient — 连接与 join（SPEC §5.2）', () => {
  it('connect → connecting；open 后 join 原房间并转 connected', () => {
    const { sockets, client, states } = setup()
    client.connect(URL, ROOM, DEVICE)
    expect(states).toEqual(['connecting'])
    expect(sockets).toHaveLength(1)
    sockets[0].fire('open')
    expect(states).toEqual(['connecting', 'connected'])
    expect(sockets[0].sent).toEqual([joinMsg()])
  })

  it('重复 connect 切换房间：关闭旧连接、新 socket 用新房间 join', () => {
    const { sockets, client } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    client.connect('wss://x/ws?room=ABCD', 'ABCD', DEVICE)
    expect(sockets).toHaveLength(2)
    expect(sockets[0].closed).toBe(true)
    // 旧 socket 迟到的 close 不触发重连（socket 不匹配当前）
    sockets[0].fire('close')
    awaitTick(10_000)
    expect(sockets).toHaveLength(2)
    sockets[1].fire('open')
    expect(sockets[1].sent).toEqual([joinMsg('ABCD')])
  })

  it('signal / leave 代理到当前 socket', () => {
    const { sockets, client } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    const payload: SignalPayload = { kind: 'offer', sdp: 'v=0...' }
    client.signal('dev-2', payload)
    client.leave()
    expect(sockets[0].sent).toEqual([
      joinMsg(),
      JSON.stringify({ type: 'signal', to: 'dev-2', payload }),
      JSON.stringify({ type: 'leave' }),
    ])
  })
})

describe('ReconnectingSignalingClient — 断线自动重连（T09 验收 1）', () => {
  it('close 后指数退避重连：1s → 2s → 4s → 8s → 16s → 30s 封顶', async () => {
    const { sockets, client, states } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')

    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]
    for (let i = 0; i < delays.length; i++) {
      sockets[i].fire('close')
      expect(states[states.length - 1]).toBe('reconnecting')
      // 退避期间不新建 socket
      await vi.advanceTimersByTimeAsync(delays[i] - 1)
      expect(sockets).toHaveLength(i + 1)
      // 到期才重连
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(i + 2)
    }
  })

  it('重连成功：重新 join 原房间码，room_state 恢复设备列表（T09 验收 3）', async () => {
    const { sockets, client, roomStates } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    sockets[0].fire('message', JSON.stringify({ type: 'room_state', peers: [PEER_B] }))
    expect(roomStates).toEqual([[PEER_B]])

    sockets[0].fire('close')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
    sockets[1].fire('open')
    // 重连后自动重新 join 原房间码，房间码不丢
    expect(sockets[1].sent).toEqual([joinMsg()])
    // 服务端重发 room_state → 列表恢复
    sockets[1].fire('message', JSON.stringify({ type: 'room_state', peers: [PEER_B, PEER_C] }))
    expect(roomStates[roomStates.length - 1]).toEqual([PEER_B, PEER_C])
  })

  it('重连成功后失败计数清零：短退避重新开始', async () => {
    const { sockets, client } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    // 失败 5 次（退避已到 16s）
    for (let i = 0; i < 5; i++) {
      sockets[i].fire('close')
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i)
    }
    expect(sockets).toHaveLength(6)
    // 第 6 次重连成功
    sockets[5].fire('open')
    sockets[5].fire('close')
    await vi.advanceTimersByTimeAsync(999)
    expect(sockets).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(7) // 又回到 1s 起步
  })

  it('error + close 双事件只排程一次重连', async () => {
    const { sockets, client } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    sockets[0].fire('error')
    sockets[0].fire('close')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
  })
})

describe('ReconnectingSignalingClient — 放弃与手动恢复（T09 验收 2）', () => {
  it('连续失败达到上限 → offline 不再重连，转手动操作', async () => {
    const { sockets, client, states, gaveUp } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    // 前 10 次退避重连都失败（1,2,4,8,16,30×5）
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]
    for (const d of delays) {
      sockets[sockets.length - 1].fire('close')
      await vi.advanceTimersByTimeAsync(d)
    }
    expect(sockets).toHaveLength(11)
    // 第 11 个连接也失败 → 放弃
    sockets[10].fire('close')
    expect(gaveUp.count).toBe(1)
    expect(states[states.length - 1]).toBe('offline')
    // 之后不再有任何重连
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sockets).toHaveLength(11)
  })

  it('retry() 从 offline 恢复：重置计数、立即重连、成功后 connected', async () => {
    const { sockets, client, states } = setup({ maxAttempts: 2 })
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    sockets[0].fire('close')
    await vi.advanceTimersByTimeAsync(1000)
    sockets[1].fire('close')
    await vi.advanceTimersByTimeAsync(2000)
    sockets[2].fire('close') // 达到 maxAttempts=2 → offline
    expect(states[states.length - 1]).toBe('offline')

    client.retry()
    expect(states[states.length - 1]).toBe('connecting')
    expect(sockets).toHaveLength(4)
    sockets[3].fire('open')
    expect(states[states.length - 1]).toBe('connected')
    expect(sockets[3].sent).toEqual([joinMsg()])
  })

  it('手动 close() 后不再自动重连', () => {
    const { sockets, client, states } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    client.close()
    sockets[0].fire('close')
    sockets[0].fire('error')
    awaitTick(300_000)
    expect(sockets).toHaveLength(1)
    expect(states).toEqual(['connecting', 'connected', 'idle'])
  })

  it('forceDisconnect：模拟外力断开 → 触发自动重连（区别于 close）', async () => {
    const { sockets, client, states } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    client.forceDisconnect()
    sockets[0].fire('close') // 真实 WebSocket：close() 后随附 close 事件
    expect(states[states.length - 1]).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2) // 自动重连照常发生
  })

  it('close 清除已排程的重连定时器', async () => {
    const { sockets, client } = setup()
    client.connect(URL, ROOM, DEVICE)
    sockets[0].fire('open')
    sockets[0].fire('close')
    expect(sockets).toHaveLength(1)
    client.close()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sockets).toHaveLength(1)
  })
})

/** 同步推进 fake 时钟（不 flush 微任务） */
function awaitTick(ms: number) {
  vi.advanceTimersByTime(ms)
}
