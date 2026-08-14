import { describe, expect, it } from 'vitest'
import { Room, deviceIdFromUrl, PRESENCE_PREFIX } from './roomDo'
import type { Env } from './roomDo'
import type { ClientMessage, DeviceInfo, ServerMessage } from '../../src/protocol/signaling'

/**
 * T10 单测：用 fake DurableObjectState 模拟 evict 唤醒。
 *
 * 结构：FakeStorage（map 持久化）+ FakeCtx（按 tag 保留 socket 的 Hibernation 模拟）。
 * 「evict」= 丢弃旧 Room 实例，用共享 storage + 保留的 socket（tag 仍在）新建实例。
 */

interface WsLike {
  id: string
  received: ServerMessage[]
  closed: boolean
  send(raw: string): void
  close(code?: number, reason?: string): void
}

class FakeStorage {
  readonly data = new Map<string, unknown>()
  alarms: number[] = []
  deletedAll = false
  failList = false
  failPut = false

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }
  async put(key: string, value: unknown): Promise<void> {
    if (this.failPut) throw new Error('put boom')
    this.data.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }
  async list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>> {
    if (this.failList) throw new Error('list boom')
    const out = new Map<string, T>()
    for (const [k, v] of this.data) if (k.startsWith(options.prefix)) out.set(k, v as T)
    return out
  }
  setAlarm(ms: number): Promise<void> {
    this.alarms.push(ms)
    return Promise.resolve()
  }
  async deleteAll(): Promise<void> {
    this.deletedAll = true
    this.data.clear()
  }
}

class FakeCtx {
  readonly storage: FakeStorage
  private readonly sockets = new Map<WsLike, string[]>()

  constructor(storage: FakeStorage) {
    this.storage = storage
  }

  /** 模拟 fetch 里 acceptWebSocket(ws, [deviceId])（测试不走 fetch，直接预登记） */
  register(ws: WsLike, tags: string[]): void {
    this.sockets.set(ws, tags)
  }

  getWebSockets(tag?: string | string[]): WebSocket[] {
    const tags = Array.isArray(tag) ? tag : tag ? [tag] : undefined
    const entries = [...this.sockets.entries()]
    const matched = tags ? entries.filter(([, t]) => tags.every((x) => t.includes(x))) : entries
    return matched.map(([ws]) => ws as unknown as WebSocket)
  }
}

const ws = (id: string): WsLike => ({
  id,
  received: [],
  closed: false,
  send(raw: string) {
    this.received.push(JSON.parse(raw) as ServerMessage)
  },
  close() {
    this.closed = true
  },
})

const device = (id: string, name = id): DeviceInfo => ({ id, name, kind: 'phone' })
const joinMsg = (d: DeviceInfo) => JSON.stringify({ type: 'join', room: 'R', device: d })
const signalMsg = (to: string, payload: { kind: 'offer' | 'answer'; sdp: string }) =>
  JSON.stringify({ type: 'signal', to, payload })
const asWs = (w: WsLike) => w as unknown as WebSocket
const newRoom = (storage: FakeStorage) => {
  const ctx = new FakeCtx(storage)
  const room = new Room(ctx as unknown as DurableObjectState, {} as unknown as Env)
  return { ctx, room }
}

/** 两台设备入房（旧实例） */
async function joinTwo(storage: FakeStorage) {
  const { ctx, room } = newRoom(storage)
  const a = ws('a')
  const b = ws('b')
  ctx.register(a, ['a'])
  ctx.register(b, ['b'])
  await room.webSocketMessage(asWs(a), joinMsg(device('a', 'DevA')))
  await room.webSocketMessage(asWs(b), joinMsg(device('b', 'DevB')))
  return { a, b, room }
}

describe('Room — presence 持久化（T10 验收 1）', () => {
  it('join 持久化 deviceId → info；leave 删除 presence 并关闭连接', async () => {
    const storage = new FakeStorage()
    const { ctx, room } = newRoom(storage)
    const a = ws('a')
    ctx.register(a, ['a'])
    await room.webSocketMessage(asWs(a), joinMsg(device('a', 'DevA')))

    expect(await storage.get(PRESENCE_PREFIX + 'a')).toEqual({ id: 'a', name: 'DevA', kind: 'phone' })

    await room.webSocketMessage(asWs(a), JSON.stringify({ type: 'leave' } satisfies ClientMessage))
    expect(await storage.get(PRESENCE_PREFIX + 'a')).toBeUndefined()
    expect(a.closed).toBe(true)
  })

  it('断开（webSocketClose）也删除 presence 并广播 peer_left', async () => {
    const storage = new FakeStorage()
    const { room, a, b } = await joinTwo(storage)
    expect(await storage.get(PRESENCE_PREFIX + 'b')).toBeTruthy()
    await room.webSocketClose(asWs(b), 1005, '', false)
    expect(await storage.get(PRESENCE_PREFIX + 'b')).toBeUndefined()
    expect(a.received.at(-1)).toEqual({ type: 'peer_left', peerId: 'b' })
  })
})

describe('Room — evict 唤醒重建（T10 验收 2/3）', () => {
  it('唤醒后 signal 转发与 join 广播与未 evict 一致，设备无需重新 join', async () => {
    const storage = new FakeStorage()
    await joinTwo(storage)

    // evict：新实例共享 storage，保留的 socket tag 仍在
    const c2 = new FakeCtx(storage)
    const a = ws('a')
    const b = ws('b')
    c2.register(a, ['a'])
    c2.register(b, ['b'])
    const room2 = new Room(c2 as unknown as DurableObjectState, {} as unknown as Env)

    // B 直接发 signal（唤醒触发 restore）→ 转发到 A
    const payload = { kind: 'offer' as const, sdp: 'v=0...' }
    await room2.webSocketMessage(asWs(b), signalMsg('a', payload))
    expect(a.received.at(-1)).toEqual({ type: 'signal', from: 'b', payload })

    // 新设备 join → 广播给已恢复的 A、B，room_state 含全部
    const c = ws('c')
    c2.register(c, ['c'])
    await room2.webSocketMessage(asWs(c), joinMsg(device('c')))
    expect(a.received.at(-1)).toEqual({ type: 'peer_joined', peer: device('c') })
    expect(b.received.at(-1)).toEqual({ type: 'peer_joined', peer: device('c') })
    expect(c.received.at(-1)).toEqual({
      type: 'room_state',
      peers: [device('a', 'DevA'), device('b', 'DevB'), device('c')],
    })
  })

  it('唤醒后 leave：广播 peer_left 并删除 presence', async () => {
    const storage = new FakeStorage()
    await joinTwo(storage)

    const c2 = new FakeCtx(storage)
    const a = ws('a')
    const b = ws('b')
    c2.register(a, ['a'])
    c2.register(b, ['b'])
    const room2 = new Room(c2 as unknown as DurableObjectState, {} as unknown as Env)

    await room2.webSocketMessage(asWs(b), JSON.stringify({ type: 'leave' } satisfies ClientMessage))
    expect(a.received.at(-1)).toEqual({ type: 'peer_left', peerId: 'b' })
    expect(await storage.get(PRESENCE_PREFIX + 'b')).toBeUndefined()
  })

  it('evict 后第一个事件是 close：同样清理 presence 并广播 peer_left', async () => {
    const storage = new FakeStorage()
    await joinTwo(storage)

    // evict：新实例，第一个事件就是 socket 关闭（无任何消息触发过重建）
    const c2 = new FakeCtx(storage)
    const a = ws('a')
    const b = ws('b')
    c2.register(a, ['a'])
    c2.register(b, ['b'])
    const room2 = new Room(c2 as unknown as DurableObjectState, {} as unknown as Env)

    await room2.webSocketClose(asWs(b), 1005, '', false)
    expect(await storage.get(PRESENCE_PREFIX + 'b')).toBeUndefined()
    expect(a.received.at(-1)).toEqual({ type: 'peer_left', peerId: 'b' })
  })

  it('唤醒后同设备重连：新 socket 替换旧连接，旧连接 close hook 不误删 presence', async () => {
    const storage = new FakeStorage()
    const { a } = await joinTwo(storage)

    const c2 = new FakeCtx(storage)
    c2.register(a, ['a'])
    const room2 = new Room(c2 as unknown as DurableObjectState, {} as unknown as Env)

    // a 用新 socket 重连
    const a2 = ws('a')
    c2.register(a2, ['a'])
    await room2.webSocketMessage(asWs(a2), joinMsg(device('a', 'DevA-new')))
    expect(a.closed).toBe(true) // 旧连接被 core.join 关闭
    await room2.webSocketClose(asWs(a), 1005, '', false)
    expect(await storage.get(PRESENCE_PREFIX + 'a')).toEqual({
      id: 'a',
      name: 'DevA-new',
      kind: 'phone',
    })
    expect(a2.closed).toBe(false)
  })

  it('presence 重建只发生一次：restore 后写入 storage 的条目不会混入', async () => {
    const storage = new FakeStorage()
    await joinTwo(storage)

    const c2 = new FakeCtx(storage)
    const a = ws('a')
    const b = ws('b')
    c2.register(a, ['a'])
    c2.register(b, ['b'])
    const room2 = new Room(c2 as unknown as DurableObjectState, {} as unknown as Env)
    // 首次消息触发 restore
    await room2.webSocketMessage(asWs(a), signalMsg('b', { kind: 'answer', sdp: 'x' }))

    // restore 之后才写入的 presence 不应被再次读取
    await storage.put(PRESENCE_PREFIX + 'ghost', device('ghost'))
    const c = ws('c')
    c2.register(c, ['c'])
    await room2.webSocketMessage(asWs(c), joinMsg(device('c')))
    const roomState = c.received.at(-1) as Extract<ServerMessage, { type: 'room_state' }>
    expect(roomState.peers.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('Room — 脏数据与持久化失败兜底（T10 验收 4）', () => {
  it('脏数据：presence 在但 socket 不在 → 跳过并清理', async () => {
    const storage = new FakeStorage()
    await storage.put(PRESENCE_PREFIX + 'dead', device('dead'))
    await storage.put(PRESENCE_PREFIX + 'b', device('b'))

    const c = new FakeCtx(storage)
    const b = ws('b')
    c.register(b, ['b']) // 只有 b 的 socket 存活
    const room = new Room(c as unknown as DurableObjectState, {} as unknown as Env)

    // b 向 dead 发 signal：dead 未被恢复 → error 回给 b
    await room.webSocketMessage(asWs(b), signalMsg('dead', { kind: 'offer', sdp: 'x' }))
    expect(b.received.at(-1)).toEqual({ type: 'error', reason: 'peer not found' })
    // 脏数据被清理
    expect(await storage.get(PRESENCE_PREFIX + 'dead')).toBeUndefined()
    // 存活设备正常恢复
    expect(await storage.get(PRESENCE_PREFIX + 'b')).toBeTruthy()
  })

  it('storage.put 失败兜底：join 在内存仍生效，presence 缺失仅影响唤醒恢复', async () => {
    const storage = new FakeStorage()
    storage.failPut = true
    const { ctx, room } = newRoom(storage)
    const a = ws('a')
    ctx.register(a, ['a'])
    await room.webSocketMessage(asWs(a), joinMsg(device('a')))
    expect(a.received.at(-1)).toEqual({ type: 'room_state', peers: [device('a')] })
    expect(await storage.get(PRESENCE_PREFIX + 'a')).toBeUndefined()
  })

  it('storage.list 失败兜底：按空房间处理，join 仍可用', async () => {
    const storage = new FakeStorage()
    storage.failList = true
    const { ctx, room } = newRoom(storage)
    const a = ws('a')
    ctx.register(a, ['a'])
    await room.webSocketMessage(asWs(a), joinMsg(device('a')))
    expect(a.received.at(-1)).toEqual({ type: 'room_state', peers: [device('a')] })
  })

  it('storage.list 失败 + alarm：不回收房间（deleteAll 会抹掉存活设备 presence）', async () => {
    const storage = new FakeStorage()
    await storage.put(PRESENCE_PREFIX + 'a', device('a'))
    storage.failList = true
    const c = new FakeCtx(storage)
    c.register(ws('a'), ['a']) // a 的 socket 存活
    const room = new Room(c as unknown as DurableObjectState, {} as unknown as Env)

    await room.alarm()
    expect(storage.deletedAll).toBe(false) // 不回收
    expect(storage.alarms.length).toBe(1) // 顺延
  })

  it('脏 presence 字段非法（老版本/损坏数据）：跳过并清理', async () => {
    const storage = new FakeStorage()
    await storage.put(PRESENCE_PREFIX + 'bad', { id: '', name: 42 }) // 非法形状
    await storage.put(PRESENCE_PREFIX + 'b', device('b'))

    const c = new FakeCtx(storage)
    const b = ws('b')
    c.register(b, ['b'])
    const room = new Room(c as unknown as DurableObjectState, {} as unknown as Env)

    await room.webSocketMessage(asWs(b), signalMsg('bad', { kind: 'offer', sdp: 'x' }))
    expect(b.received.at(-1)).toEqual({ type: 'error', reason: 'peer not found' })
    expect(await storage.get(PRESENCE_PREFIX + 'bad')).toBeUndefined() // 非法条目已清理
  })
})

describe('Room — alarm 回收（T10：先重建再判空）', () => {
  it('有活跃 presence：alarm 顺延，不误删房间', async () => {
    const storage = new FakeStorage()
    await storage.put(PRESENCE_PREFIX + 'a', device('a'))
    await storage.put(PRESENCE_PREFIX + 'b', device('b'))
    const c = new FakeCtx(storage)
    c.register(ws('a'), ['a'])
    c.register(ws('b'), ['b'])
    const room = new Room(c as unknown as DurableObjectState, {} as unknown as Env)

    await room.alarm()
    expect(storage.deletedAll).toBe(false)
    expect(storage.alarms.length).toBe(1) // 顺延 24h
  })

  it('空房间：alarm 删除全部状态（回收）', async () => {
    const storage = new FakeStorage()
    const room = new Room(new FakeCtx(storage) as unknown as DurableObjectState, {} as unknown as Env)
    await room.alarm()
    expect(storage.deletedAll).toBe(true)
  })
})

describe('Room — URL deviceId 提取', () => {
  it('deviceIdFromUrl 解析 ?device= 参数', () => {
    expect(deviceIdFromUrl('wss://h/ws?room=K7Q2&device=abc-123')).toBe('abc-123')
    expect(deviceIdFromUrl('wss://h/ws?room=K7Q2')).toBeNull()
    expect(deviceIdFromUrl('wss://h/ws?room=K7Q2&device=')).toBeNull()
    expect(deviceIdFromUrl('not a url')).toBeNull()
  })
})
