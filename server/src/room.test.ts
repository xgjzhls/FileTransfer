import { describe, expect, it } from 'vitest'
import { RoomCore } from './room'
import type { DeviceInfo, PeerConnection, ServerMessage } from './room'

const MAX_PEERS = 8

function device(id: string, name = `dev-${id}`, kind: DeviceInfo['kind'] = 'phone'): DeviceInfo {
  return { id, name, kind }
}

/** 记录 socket 收到的消息 */
function fakeConn(): PeerConnection & { received: ServerMessage[]; closed: boolean } {
  const conn: PeerConnection & { received: ServerMessage[]; closed: boolean } = {
    received: [],
    closed: false,
    send(message) {
      this.received.push(message)
    },
    close() {
      this.closed = true
    },
  }
  return conn
}

function setup() {
  const core = new RoomCore(MAX_PEERS)
  const conns = new Map<string, ReturnType<typeof fakeConn>>()
  function join(d: DeviceInfo) {
    const conn = fakeConn()
    conns.set(d.id, conn)
    const result = core.join(d, conn)
    return { conn, result }
  }
  return { core, conns, join }
}

describe('RoomCore — join / presence', () => {
  it('第一台设备 join：收到含自己的 room_state，无广播', () => {
    const { join, conns } = setup()
    const { result } = join(device('a'))
    expect(result).toEqual({ kind: 'joined' })
    const a = conns.get('a')!
    expect(a.received).toEqual([
      { type: 'room_state', peers: [{ id: 'a', name: 'dev-a', kind: 'phone' }] },
    ])
  })

  it('第二台 join：新人收到含两台 room_state，先到者收到 peer_joined', () => {
    const { join, conns } = setup()
    join(device('a'))
    conns.get('a')!.received.length = 0 // 清空历史
    const { result } = join(device('b'))
    expect(result).toEqual({ kind: 'joined' })
    expect(conns.get('b')!.received).toEqual([
      {
        type: 'room_state',
        peers: [
          { id: 'a', name: 'dev-a', kind: 'phone' },
          { id: 'b', name: 'dev-b', kind: 'phone' },
        ],
      },
    ])
    expect(conns.get('a')!.received).toEqual([
      { type: 'peer_joined', peer: { id: 'b', name: 'dev-b', kind: 'phone' } },
    ])
  })

  it('同一 deviceId 重连（幂等）：不广播 peer_joined，仅刷新 room_state', () => {
    const { join, conns } = setup()
    join(device('a'))
    join(device('b'))
    for (const c of conns.values()) c.received.length = 0 // 清掉 join 历史
    const { result, conn } = join(device('a'))
    expect(result).toEqual({ kind: 'rejoined' })
    expect(conn.received).toEqual([
      {
        type: 'room_state',
        peers: [
          { id: 'a', name: 'dev-a', kind: 'phone' },
          { id: 'b', name: 'dev-b', kind: 'phone' },
        ],
      },
    ])
    expect(conns.get('b')!.received).toEqual([]) // b 没收到 peer_joined
  })

  it('房间满（>8）时拒绝：error + 关闭连接，现有 peer 不变', () => {
    const { join, conns } = setup()
    for (let i = 0; i < MAX_PEERS; i++) join(device(`p${i}`))
    for (const c of conns.values()) c.received.length = 0

    const { result, conn } = join(device('x'))
    expect(result).toEqual({ kind: 'full' })
    expect(conn.closed).toBe(true)
    expect(conn.received).toEqual([{ type: 'error', reason: 'room full' }])
    // 原有 8 台不受影响
    for (let i = 0; i < MAX_PEERS; i++) {
      expect(conns.get(`p${i}`)!.received).toEqual([])
    }
  })

  it('leave：其余设备收到 peer_left；不存在的 leave 不广播', () => {
    const { core, join, conns } = setup()
    join(device('a'))
    join(device('b'))
    conns.get('a')!.received.length = 0
    conns.get('b')!.received.length = 0

    expect(core.leave('b')).toEqual({ kind: 'left' })
    expect(conns.get('a')!.received).toEqual([{ type: 'peer_left', peerId: 'b' }])
    expect(conns.get('b')!.received).toEqual([]) // 离开者自己不再收

    expect(core.leave('b')).toEqual({ kind: 'noop' })
    expect(conns.get('a')!.received.length).toBe(1)
  })
})

describe('RoomCore — signal 转发', () => {
  it('A→B：B 收到 {type:signal, from:A, payload}，A 自己不收', () => {
    const { core, join, conns } = setup()
    join(device('a'))
    join(device('b'))
    for (const c of conns.values()) c.received.length = 0
    const payload = { kind: 'offer' as const, sdp: 'v=0\r\n...' }

    expect(core.signal('a', 'b', payload)).toEqual({ kind: 'forwarded' })
    expect(conns.get('b')!.received).toEqual([{ type: 'signal', from: 'a', payload }])
    expect(conns.get('a')!.received.some((m) => m.type === 'signal')).toBe(false)
  })

  it('转发到不存在的设备：发送者收到 error，目标无事', () => {
    const { core, join, conns } = setup()
    join(device('a'))
    const payload = { kind: 'answer' as const, sdp: 'a=...' }
    expect(core.signal('a', 'ghost', payload)).toEqual({ kind: 'error' })
    expect(conns.get('a')!.received.at(-1)).toEqual({ type: 'error', reason: 'peer not found' })
  })

  it('未入房的发送者不能转发', () => {
    const { core, join, conns } = setup()
    join(device('a'))
    conns.get('a')!.received.length = 0
    const payload = { kind: 'offer' as const, sdp: 'x' }
    expect(core.signal('outsider', 'a', payload)).toEqual({ kind: 'error' })
    expect(conns.get('a')!.received).toEqual([])
  })
})

describe('RoomCore — restore（T10 唤醒重建）', () => {
  it('restore 批量加入且不广播；随后 join 广播与 signal 转发与未 evict 一致', () => {
    const core = new RoomCore(MAX_PEERS)
    const connA = fakeConn()
    const connB = fakeConn()
    core.restore([
      { info: device('a'), conn: connA },
      { info: device('b'), conn: connB },
    ])
    // restore 本身不产生任何消息（设备列表对彼此未变）
    expect(connA.received).toEqual([])
    expect(connB.received).toEqual([])

    // 新设备 join → 广播给已恢复设备
    const connC = fakeConn()
    expect(core.join(device('c'), connC)).toEqual({ kind: 'joined' })
    expect(connA.received).toEqual([{ type: 'peer_joined', peer: device('c') }])
    expect(connB.received).toEqual([{ type: 'peer_joined', peer: device('c') }])
    expect(connC.received).toEqual([
      { type: 'room_state', peers: [device('a'), device('b'), device('c')] },
    ])

    // signal 转发正常
    const payload = { kind: 'offer' as const, sdp: 'v=0...' }
    expect(core.signal('a', 'b', payload)).toEqual({ kind: 'forwarded' })
    expect(connB.received.at(-1)).toEqual({ type: 'signal', from: 'a', payload })
  })

  it('restore 同 id 覆盖旧连接（唤醒后重连：新 socket 生效）', () => {
    const core = new RoomCore(MAX_PEERS)
    const connOld = fakeConn()
    core.restore([{ info: device('a'), conn: connOld }])
    const connNew = fakeConn()
    core.restore([{ info: device('a'), conn: connNew }])
    core.join(device('b'), fakeConn())
    connOld.received.length = 0
    connNew.received.length = 0

    core.signal('a', 'b', { kind: 'offer', sdp: 'x' })
    // 新连接收到（作为 from 时自己的转发目标验证用目标 b）
    expect(connOld.received).toEqual([])
    core.signal('b', 'a', { kind: 'answer', sdp: 'y' })
    expect(connNew.received.at(-1)).toEqual({ type: 'signal', from: 'b', payload: { kind: 'answer', sdp: 'y' } })
  })

  it('restore 后 leave 清理与未 evict 一致', () => {
    const core = new RoomCore(MAX_PEERS)
    const connA = fakeConn()
    const connB = fakeConn()
    core.restore([
      { info: device('a'), conn: connA },
      { info: device('b'), conn: connB },
    ])
    connA.received.length = 0
    expect(core.leave('b')).toEqual({ kind: 'left' })
    expect(connA.received).toEqual([{ type: 'peer_left', peerId: 'b' }])
    expect(core.size).toBe(1)
  })
})
