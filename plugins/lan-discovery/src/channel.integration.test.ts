/**
 * 原生信令通道（ADR-0009 / T04）wire 协议集成测试 —— Node 真实 TCP 双端冒烟。
 *
 * 用 node:net + channel.ts 原语搭建两个参考对端（TestPeer），跑真实 socket：
 * - 正常建连：B 拨 A → hello 握手 → 双向 signal 帧（字节级往返一致）
 * - 双发起竞态：A 拨 B 且 B 拨 A → 低 id 方出向存活（initiator）、高 id 方入向存活
 *   （receiver）、session 一致、被弃连接两端关闭 —— 最终状态断言（顺序无关）
 * - 坏帧（长度超上限 / 未握手即发 signal）→ 对端按协议违规关闭
 * - 断开 → 对端 peerDisconnected，可重拨重连（新 session）
 *
 * 这是 Swift/Java 原生实现的**行为参考**：原生按同一协议、同一竞态规则镜像，
 * 真机待验（T09）。本测试钉死 wire 格式与竞态语义。
 *
 * 注意：竞态消解的**瞬态事件流**（哪一侧先看到 initiator→receiver 翻转）依赖连接到达
 * 时序，本测试只断言最终收敛态（唯一通道、角色、session、被弃连接关闭）——
 * 瞬态已在 T04 设计定稿中文档化（JS 以最终 session 为键幂等处理），不作时序断言。
 */
import net from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FRAME_LENGTH_BYTES,
  MAX_FRAME_BYTES,
  decodeFrame,
  decodeFrameLength,
  encodeFrame,
  makeHello,
  makeSignal,
  resolveChannelConflict,
  type ChannelMessage,
  type SignalKind,
} from './channel'

// ---------------------------------------------------------------------------
// 参考对端：与原生（Swift/Java）必须镜像的协议状态机
// ---------------------------------------------------------------------------

interface ChannelConn {
  socket: Socket
  /** 对端 deviceId（hello 后可知；出向 = 拨号目标） */
  peerId: string | null
  session: string | null
  isOutbound: boolean
  /** 已激活（成为活跃通道） */
  active: boolean
  closed: boolean
}

interface PeerEvents {
  connected: Array<{ peerId: string; session: string; role: 'initiator' | 'receiver' }>
  disconnected: string[]
  messages: Array<{ from: string; session: string; kind: SignalKind; sdp: string }>
}

class TestPeer {
  readonly id: string
  readonly events: PeerEvents = { connected: [], disconnected: [], messages: [] }
  private server: net.Server | null = null
  private conns: ChannelConn[] = []
  /** peerId → 活跃通道（每对端恰好一条；竞态收敛后） */
  readonly active = new Map<string, ChannelConn>()
  lastProtocolViolation: string | null = null

  constructor(id: string) {
    this.id = id
  }

  async listen(): Promise<number> {
    this.server = net.createServer((socket) => this.handleInbound(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.removeListener('error', reject)
        resolve()
      })
    })
    const addr = this.server.address() as net.AddressInfo
    return addr.port
  }

  get listeningPort(): number {
    return (this.server!.address() as net.AddressInfo).port
  }

  /** 拨号对端（模拟原生 connect()：TCP 连上后发 hello，再走竞态判定） */
  async dial(peer: TestPeer, host = '127.0.0.1'): Promise<void> {
    const socket = net.connect(peer.listeningPort, host)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const conn: ChannelConn = {
      socket,
      peerId: peer.id,
      session: makeSession(),
      isOutbound: true,
      active: false,
      closed: false,
    }
    this.conns.push(conn)
    this.attachReadLoop(conn)
    socket.write(Buffer.from(encodeFrame(makeHello(this.id, conn.session!))))
    // 出向激活点：发送 hello 后立即尝试激活（原生同序：send hello → activate）
    this.activate(conn)
  }

  /** 向活跃通道发 signal 帧（模拟 sendMessage） */
  send(peerId: string, kind: SignalKind, sdp: string): void {
    const conn = this.active.get(peerId)
    if (!conn) throw new Error(`NOT_CONNECTED:${peerId}`)
    conn.socket.write(Buffer.from(encodeFrame(makeSignal(kind, sdp))))
  }

  closeChannel(peerId: string): void {
    const conn = this.active.get(peerId)
    conn?.socket.end()
  }

  private handleInbound(socket: Socket): void {
    const conn: ChannelConn = {
      socket,
      peerId: null,
      session: null,
      isOutbound: false,
      active: false,
      closed: false,
    }
    this.conns.push(conn)
    this.attachReadLoop(conn)
  }

  /**
   * 读循环（字节流状态机，与原生两段式读等价的参考实现）：
   * 4B 长度前缀 → 恰好 length 字节载荷 → 重复；入向首帧必须是 hello，之后只收 signal。
   * socket close/error → 断线收尾（原生 same 语义：连接失败/对端关闭 → peerDisconnected）。
   */
  private attachReadLoop(conn: ChannelConn): void {
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stage: 'length' | 'payload' = 'length'
    let payloadLen = 0
    conn.socket.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      if (conn.closed) return
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      for (;;) {
        if (stage === 'length') {
          if (pending.length < FRAME_LENGTH_BYTES) break
          let len: number
          try {
            len = decodeFrameLength(pending.subarray(0, FRAME_LENGTH_BYTES))
          } catch {
            this.failChannel(conn)
            return
          }
          pending = pending.subarray(FRAME_LENGTH_BYTES)
          payloadLen = len
          stage = 'payload'
        } else {
          if (pending.length < payloadLen) break
          this.onFrame(conn, pending.subarray(0, payloadLen))
          pending = pending.subarray(payloadLen)
          stage = 'length'
        }
      }
    })
    conn.socket.on('close', () => this.teardownConn(conn, conn.active))
    conn.socket.on('error', () => this.teardownConn(conn, conn.active))
  }

  private onFrame(conn: ChannelConn, payload: Buffer): void {
    let msg: ChannelMessage
    try {
      msg = decodeFrame(payload)
    } catch {
      this.failChannel(conn)
      return
    }
    if (msg.type === 'hello') {
      // 入向首帧必须是 hello（出向不应收到 hello —— 原生 v1 接收方不回 hello）
      if (conn.isOutbound || conn.peerId !== null) {
        this.failChannel(conn)
        return
      }
      conn.peerId = msg.id
      conn.session = msg.session
      this.activate(conn) // 入向激活点：hello 后尝试激活（竞态判定在 activate 内）
      return
    }
    // signal
    if (conn.peerId === null) {
      // 未握手就发 signal → 协议违规（原生同语义）
      this.failChannel(conn)
      return
    }
    this.events.messages.push({ from: conn.peerId, session: conn.session!, kind: msg.kind, sdp: msg.sdp })
  }

  /**
   * 激活点（原生在「出向 ready 发完 hello」与「入向收到 hello」两处调用）：
   * 若该对端已有活跃通道 → 竞态消解（低 id 胜）：
   *   - 保留「低 id 方发起」的连接：我 id < 对端 id → 保留出向；否则保留入向
   *   - 被弃连接：已激活的记 peerDisconnected；未激活的静默关闭（从未对外）
   */
  private activate(candidate: ChannelConn): void {
    if (candidate.closed || candidate.peerId === null) return
    const existing = this.active.get(candidate.peerId)
    if (!existing || existing.closed) {
      this.activateAs(candidate)
      return
    }
    // 竞态：保留「低 id 方发起」的连接（两端独立套同一规则 → 收敛）
    const keepOutbound = resolveChannelConflict(this.id, candidate.peerId) === 'keep-outbound'
    if (candidate.isOutbound === keepOutbound) {
      // 候选胜：弃 existing（若已对外 → peerDisconnected）
      this.teardownConn(existing, true)
      this.activateAs(candidate)
    } else {
      // 候选弃：静默关闭（候选从未激活对外）
      this.teardownConn(candidate, false)
    }
  }

  private activateAs(candidate: ChannelConn): void {
    this.active.set(candidate.peerId!, candidate)
    candidate.active = true
    this.events.connected.push({
      peerId: candidate.peerId!,
      session: candidate.session!,
      role: candidate.isOutbound ? 'initiator' : 'receiver',
    })
  }

  private teardownConn(conn: ChannelConn, wasActive: boolean): void {
    if (conn.closed) return
    conn.closed = true
    if (conn.peerId && wasActive && this.active.get(conn.peerId) === conn) {
      this.active.delete(conn.peerId)
      this.events.disconnected.push(conn.peerId)
    }
    conn.socket.destroy()
  }

  private failChannel(conn: ChannelConn): void {
    this.lastProtocolViolation = 'PROTOCOL_VIOLATION'
    this.teardownConn(conn, conn.active)
  }

  /** 已被关闭的连接数（断言「被弃连接已关闭」用） */
  closedCount(): number {
    return this.conns.filter((c) => c.closed).length
  }

  totalConns(): number {
    return this.conns.length
  }

  close(): void {
    for (const c of this.conns) c.socket.destroy()
    this.server?.close()
  }
}

function makeSession(): string {
  return `sess-${Math.random().toString(36).slice(2)}`
}

const LOW = '4f6a3f4c-0c2e-4b8a-9d5f-1e2a3b4c5d6e' // 低 id（竞态胜出方）
const HIGH = '9c1e2d34-5678-4abc-9def-0123456789ab' // 高 id

async function until(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const peers: TestPeer[] = []
function makePeer(id: string): TestPeer {
  const p = new TestPeer(id)
  peers.push(p)
  return p
}

afterEach(() => {
  for (const p of peers) p.close()
  peers.length = 0
})

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

describe('T04 wire 协议：正常建连 + 双向收发（真 TCP）', () => {
  it('B 拨 A：hello 握手 → 双向 signal 帧字节级一致', async () => {
    const a = makePeer(HIGH) // 只监听（接收方）
    await a.listen()
    const b = makePeer(LOW)
    await b.listen() // B 也在线（可被 A 反向发现），但仅 B 发起

    await b.dial(a)

    await until(() => a.events.connected.length === 1, 'A 收到 peerConnected')
    await until(() => b.events.connected.length === 1, 'B peerConnected')

    // 角色：发起方 B = initiator，接收方 A = receiver；session 一致（B 生成的）
    expect(b.events.connected[0]).toMatchObject({ peerId: HIGH, role: 'initiator' })
    expect(a.events.connected[0]).toMatchObject({ peerId: LOW, role: 'receiver' })
    expect(a.events.connected[0].session).toBe(b.events.connected[0].session)

    // 双向 signal（含中文 + base64url 载荷）
    const offerSdp = 'gzip-base64-offer-' + btoa('v=0 candidate:1 192.168.1.5')
    const answerSdp = '5L2g5aW977yM55So5Zue5o+S5bqU5a2Q'
    b.send(HIGH, 'offer', offerSdp)
    a.send(LOW, 'answer', answerSdp)

    await until(() => a.events.messages.length === 1, 'A 收到 offer')
    await until(() => b.events.messages.length === 1, 'B 收到 answer')
    expect(a.events.messages[0]).toEqual({
      from: LOW,
      session: b.events.connected[0].session,
      kind: 'offer',
      sdp: offerSdp,
    })
    expect(b.events.messages[0]).toEqual({
      from: HIGH,
      session: b.events.connected[0].session,
      kind: 'answer',
      sdp: answerSdp,
    })

    // 每条链路恰好一个活跃通道；A 侧为入向、B 侧为出向
    expect(a.active.size).toBe(1)
    expect(b.active.size).toBe(1)
    expect(a.active.get(LOW)!.isOutbound).toBe(false)
    expect(b.active.get(HIGH)!.isOutbound).toBe(true)
  })
})

describe('T04 wire 协议：双发起竞态 → 唯一通道', () => {
  it('两台同时发起：低 id 方出向存活（initiator）、高 id 方入向存活（receiver）、session 一致、被弃连接两端关闭', async () => {
    const a = makePeer(LOW)
    await a.listen()
    const b = makePeer(HIGH)
    await b.listen()

    await Promise.all([a.dial(b), b.dial(a)])

    // 收敛：两侧各恰好 1 条活跃通道，且幸存连接 = 低 id（A）发起的连接
    await until(
      () =>
        a.active.size === 1 &&
        b.active.size === 1 &&
        a.active.get(HIGH)?.isOutbound === true &&
        b.active.get(LOW)?.isOutbound === false,
      '竞态收敛到唯一通道（A 出向 / B 入向）',
    )

    const aConn = a.active.get(HIGH)!
    const bConn = b.active.get(LOW)!
    expect(aConn.isOutbound).toBe(true)
    expect(bConn.isOutbound).toBe(false)

    // 最终角色（事件流最后一个）：A initiator / B receiver
    const aConnected = a.events.connected.filter((e) => e.peerId === HIGH)
    const bConnected = b.events.connected.filter((e) => e.peerId === LOW)
    expect(aConnected[aConnected.length - 1]).toMatchObject({ peerId: HIGH, role: 'initiator' })
    expect(bConnected[bConnected.length - 1]).toMatchObject({ peerId: LOW, role: 'receiver' })

    // session 一致（= 低 id 方 A 生成的 session）
    expect(aConnected[aConnected.length - 1].session).toBe(bConnected[bConnected.length - 1].session)

    // 被弃连接在两端都关闭：各 2 连接（1 出向 + 1 入向），恰 1 条存活
    expect(a.totalConns()).toBe(2)
    expect(b.totalConns()).toBe(2)
    expect(a.closedCount()).toBe(1)
    expect(b.closedCount()).toBe(1)

    // 收敛后通道可正常收发（幸存连接 = A→B）
    a.send(HIGH, 'offer', 'sdp-A-offer')
    await until(() => b.events.messages.length === 1, 'B 收到 A 的 offer')
    expect(b.events.messages[0]).toMatchObject({ from: LOW, kind: 'offer' })
    b.send(LOW, 'answer', 'sdp-B-answer')
    await until(() => a.events.messages.length === 1, 'A 收到 B 的 answer')
    expect(a.events.messages[0]).toMatchObject({ from: HIGH, kind: 'answer' })
  })

  it('错峰发起（A 先拨、收敛后 B 再拨）：同样收敛，且最终角色由低 id 规则决定', async () => {
    const a = makePeer(LOW)
    await a.listen()
    const b = makePeer(HIGH)
    await b.listen()

    await a.dial(b)
    await until(() => a.active.size === 1 && b.active.size === 1, 'A 拨号后收敛')

    await b.dial(a)
    await until(
      () =>
        a.active.size === 1 &&
        b.active.size === 1 &&
        a.active.get(HIGH)?.isOutbound === true &&
        b.active.get(LOW)?.isOutbound === false,
      'B 补拨后仍收敛（A 出向存活）',
    )

    const aConnected = a.events.connected.filter((e) => e.peerId === HIGH)
    const bConnected = b.events.connected.filter((e) => e.peerId === LOW)
    expect(aConnected[aConnected.length - 1]).toMatchObject({ role: 'initiator' })
    expect(bConnected[bConnected.length - 1]).toMatchObject({ role: 'receiver' })
    expect(aConnected[aConnected.length - 1].session).toBe(bConnected[bConnected.length - 1].session)

    // 每条链路最终恰好 1 条活跃通道
    expect(a.active.size).toBe(1)
    expect(b.active.size).toBe(1)
  })
})

describe('T04 wire 协议：坏帧与断线', () => {
  it('长度前缀超上限 → 对端按协议违规关闭连接', async () => {
    const a = makePeer(LOW)
    await a.listen()

    // 向 A 的监听端口灌一个长度超上限的帧头（模拟恶意/损坏客户端）
    const raw = net.connect(a.listeningPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      raw.once('connect', resolve)
      raw.once('error', reject)
    })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    raw.write(header)

    await until(() => a.lastProtocolViolation === 'PROTOCOL_VIOLATION', 'A 判定协议违规')
    raw.destroy()
  })

  it('未握手即发 signal → 协议违规关闭', async () => {
    const a = makePeer(LOW)
    await a.listen()

    const raw = net.connect(a.listeningPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      raw.once('connect', resolve)
      raw.once('error', reject)
    })
    // 跳过 hello 直接发 signal
    raw.write(Buffer.from(encodeFrame(makeSignal('offer', 'sdp-before-hello'))))
    await until(() => a.lastProtocolViolation === 'PROTOCOL_VIOLATION', 'A 判定协议违规')
    raw.destroy()
  })

  it('断开 → 对端 peerDisconnected，可重拨重连（新 session）', async () => {
    const a = makePeer(HIGH)
    await a.listen()
    const b = makePeer(LOW)
    await b.listen()

    await b.dial(a)
    await until(() => a.events.connected.length === 1 && b.events.connected.length === 1, '首次握手')

    b.closeChannel(HIGH) // socket.end() → 对端读到 EOF
    await until(() => a.events.disconnected.includes(LOW), 'A 收到断线')
    await until(() => b.events.disconnected.includes(HIGH), 'B 侧通道清理')

    // 重新拨号（模拟重新发现/重连）→ 新 session 新通道
    await b.dial(a)
    await until(() => a.events.connected.length === 2 && b.events.connected.length === 2, '重连握手')
    expect(a.events.connected[1].session).not.toBe(a.events.connected[0].session)
    expect(a.events.connected[1]).toMatchObject({ peerId: LOW, role: 'receiver' })
  })
})
