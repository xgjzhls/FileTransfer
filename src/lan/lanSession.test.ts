/**
 * LanDiscoverySession 单测（ADR-0009 / T05）—— 假 transport 注入，
 * 覆盖：start 编排（订阅/端口回退/浏览）/ stop 回滚 / 注册表维护 /
 * connect 幂等 / 活跃通道 session 键 / 事件透传 / 错误文案映射。
 */
import { describe, expect, it } from 'vitest'
import { LanDiscoverySession, describeLanError, LAN_PORTS } from './lanSession'
import type { LanTransport } from './lanSession'
import type {
  ChannelMessageEvent,
  LanDevice,
  PeerConnectedEvent,
  SignalingErrorEvent,
  TrackedDevice,
} from 'lan-discovery'
import type { LanEventData } from './lanSession'

class FakeTransport implements LanTransport {
  calls: string[] = []
  private listeners = new Map<string, Array<(e: LanEventData) => void>>()
  serverFailPorts = new Set<number>()
  browseOk = true
  browsePermissionDenied = false
  connectResult: { ok: boolean; error?: string } = { ok: true }
  disconnected: string[] = []

  async startSignalingServer(options: { device: LanDevice }): Promise<{ ok: boolean; port?: number; error?: string }> {
    this.calls.push(`startSignalingServer:${options.device.port}`)
    if (this.serverFailPorts.has(options.device.port)) return { ok: false, error: 'PORT_IN_USE' }
    return { ok: true, port: options.device.port }
  }

  async stopSignalingServer(): Promise<{ ok: boolean }> {
    this.calls.push('stopSignalingServer')
    return { ok: true }
  }

  async startBrowsing(): Promise<{ ok: boolean; error?: string; permissionDenied?: boolean }> {
    this.calls.push('startBrowsing')
    if (!this.browseOk) {
      return { ok: false, error: 'LOCAL_NETWORK_DENIED', permissionDenied: this.browsePermissionDenied }
    }
    return { ok: true }
  }

  async stopBrowsing(): Promise<{ ok: boolean }> {
    this.calls.push('stopBrowsing')
    return { ok: true }
  }

  async connect(options: { peer: LanDevice; myId: string }): Promise<{ ok: boolean; error?: string }> {
    this.calls.push(`connect:${options.peer.id}`)
    return this.connectResult
  }

  async disconnect(options: { peerId: string }): Promise<{ ok: boolean }> {
    this.disconnected.push(options.peerId)
    return { ok: true }
  }

  async sendMessage(options: { peerId: string; kind: string; sdp: string }): Promise<{ ok: boolean; error?: string }> {
    this.calls.push(`sendMessage:${options.peerId}:${options.kind}`)
    return { ok: true }
  }

  async addListener(eventName: string, listener: (e: LanEventData) => void): Promise<{ remove(): void }> {
    const arr = this.listeners.get(eventName) ?? []
    arr.push(listener)
    this.listeners.set(eventName, arr)
    return {
      remove: () => {
        const i = arr.indexOf(listener)
        if (i >= 0) arr.splice(i, 1)
      },
    }
  }

  emit(eventName: string, data: LanEventData): void {
    for (const l of this.listeners.get(eventName) ?? []) l(data)
  }
}

const selfDevice: LanDevice = {
  name: '测试机',
  id: 'aaaa1111',
  kind: 'phone',
  port: 8443,
  ver: '1',
  serviceName: 'aaaa1111',
  domain: 'local.',
}

function peerDevice(id: string, overrides: Partial<LanDevice> = {}): TrackedDevice {
  return {
    name: `设备-${id}`,
    id,
    kind: 'phone',
    port: 8443,
    ver: '1',
    serviceName: id,
    domain: 'local.',
    ...overrides,
    firstSeen: 0,
    lastSeen: 0,
  }
}

function makeSession(transport: FakeTransport, events: Record<string, (v: never) => void>) {
  const noop = () => {}
  const all: Record<string, (v: never) => void> = {
    onDevicesChanged: noop,
    onPeerConnected: noop,
    onPeerDisconnected: noop,
    onSignal: noop,
    onServerChange: noop,
    onPermissionDenied: noop,
    onError: noop,
    ...events,
  }
  const session = new LanDiscoverySession({
    transport,
    device: selfDevice,
    events: all as never,
    pruneIntervalMs: 10_000_000, // 测试中不触发定时器
  })
  return session
}

describe('start 编排', () => {
  it('订阅事件 → 起服务器（默认端口）→ 开始浏览 → running', async () => {
    const t = new FakeTransport()
    const events: Record<string, unknown> = {}
    const session = makeSession(t, events as never)
    const r = await session.start()
    expect(r).toEqual({ ok: true })
    expect(session.running).toBe(true)
    expect(session.port).toBe(8443)
    expect(t.calls).toEqual(['startSignalingServer:8443', 'startBrowsing'])
  })

  it('PORT_IN_USE → 依次尝试后续端口，全部失败返回错误', async () => {
    const t = new FakeTransport()
    t.serverFailPorts = new Set(LAN_PORTS)
    const errors: string[] = []
    const session = makeSession(t, { onError: (c: string) => errors.push(c) } as never)
    const r = await session.start()
    expect(r).toEqual({ ok: false, error: 'PORT_IN_USE' })
    expect(t.calls).toEqual(LAN_PORTS.map((p) => `startSignalingServer:${p}`))
    expect(errors).toEqual(['PORT_IN_USE'])
    expect(session.running).toBe(false)
    // 失败回滚：反注册监听
    expect(t.calls.includes('startBrowsing')).toBe(false)
  })

  it('首个端口被占 → 第二个端口成功', async () => {
    const t = new FakeTransport()
    t.serverFailPorts = new Set([8443])
    const session = makeSession(t, {} as never)
    const r = await session.start()
    expect(r).toEqual({ ok: true })
    expect(session.port).toBe(8444)
    expect(t.calls).toEqual(['startSignalingServer:8443', 'startSignalingServer:8444', 'startBrowsing'])
  })

  it('浏览权限被拒 → onPermissionDenied + 回滚（停服务器/反注册）', async () => {
    const t = new FakeTransport()
    t.browseOk = false
    t.browsePermissionDenied = true
    const seen: string[] = []
    const session = makeSession(t, {
      onError: (c: string) => seen.push(`err:${c}`),
      onPermissionDenied: () => seen.push('denied'),
      onServerChange: (p: number | null) => seen.push(`port:${p}`),
    } as never)
    const r = await session.start()
    expect(r).toEqual({ ok: false, error: 'LOCAL_NETWORK_DENIED' })
    expect(seen).toContain('denied')
    expect(seen).toContain('port:null')
    expect(session.running).toBe(false)
  })

  it('重复 start 幂等（不重复起服务器）', async () => {
    const t = new FakeTransport()
    const session = makeSession(t, {} as never)
    await session.start()
    await session.start()
    expect(t.calls.filter((c) => c.startsWith('startSignalingServer')).length).toBe(1)
  })
})

describe('设备注册表', () => {
  it('deviceFound → 入表并通知；重复发现只刷新 lastSeen 不重复', async () => {
    const t = new FakeTransport()
    const lists: TrackedDevice[][] = []
    const session = makeSession(t, { onDevicesChanged: (d: TrackedDevice[]) => lists.push(d) } as never)
    await session.start()
    t.emit('deviceFound', peerDevice('bbbb2222'))
    t.emit('deviceFound', { ...peerDevice('bbbb2222'), port: 8444 }) // changed 重报
    expect(lists.length).toBe(2)
    expect(session.devices().length).toBe(1)
    expect(session.devices()[0].port).toBe(8444)
  })

  it('deviceLost → 移除并通知', async () => {
    const t = new FakeTransport()
    const session = makeSession(t, {} as never)
    await session.start()
    t.emit('deviceFound', peerDevice('bbbb2222'))
    expect(session.devices().length).toBe(1)
    t.emit('deviceLost', { id: 'bbbb2222' })
    expect(session.devices().length).toBe(0)
  })

  it('stop 清空注册表与活跃通道并通知空列表', async () => {
    const t = new FakeTransport()
    const lists: TrackedDevice[][] = []
    const session = makeSession(t, { onDevicesChanged: (d: TrackedDevice[]) => lists.push(d) } as never)
    await session.start()
    t.emit('deviceFound', peerDevice('bbbb2222'))
    t.emit('peerConnected', { id: 'bbbb2222', session: 's1', role: 'initiator' })
    await session.stop()
    expect(session.devices().length).toBe(0)
    expect(session.isConnected('bbbb2222')).toBe(false)
    expect(lists.at(-1)?.length).toBe(0)
    expect(t.calls).toContain('stopSignalingServer')
    expect(t.calls).toContain('stopBrowsing')
  })
})

describe('connect / 活跃通道', () => {
  it('connectTo 用 myId 拨号；已连接幂等返回 ok', async () => {
    const t = new FakeTransport()
    const session = makeSession(t, {} as never)
    await session.start()
    t.emit('peerConnected', { id: 'bbbb2222', session: 's1', role: 'receiver' })
    const r = await session.connectTo(peerDevice('bbbb2222'))
    expect(r).toEqual({ ok: true })
    expect(t.calls.some((c) => c.startsWith('connect:'))).toBe(false) // 未重复拨号
  })

  it('connectTo 失败透传原生错误', async () => {
    const t = new FakeTransport()
    t.connectResult = { ok: false, error: 'CONNECTION_TIMEOUT' }
    const session = makeSession(t, {} as never)
    await session.start()
    const r = await session.connectTo(peerDevice('bbbb2222'))
    expect(r).toEqual({ ok: false, error: 'CONNECTION_TIMEOUT' })
    expect(t.calls.filter((c) => c.startsWith('connect:'))).toEqual(['connect:bbbb2222'])
  })

  it('peerConnected → 记录活跃通道（session 键），sessionOf 可查', async () => {
    const t = new FakeTransport()
    const connected: PeerConnectedEvent[] = []
    const session = makeSession(t, { onPeerConnected: (e: PeerConnectedEvent) => connected.push(e) } as never)
    await session.start()
    t.emit('peerConnected', { id: 'bbbb2222', session: 's1', role: 'initiator' })
    expect(session.isConnected('bbbb2222')).toBe(true)
    expect(session.sessionOf('bbbb2222')).toBe('s1')
    expect(connected).toEqual([{ id: 'bbbb2222', session: 's1', role: 'initiator' }])
  })

  it('竞态瞬态：peerDisconnected 清通道，最终 session 重新激活', async () => {
    const t = new FakeTransport()
    const session = makeSession(t, {} as never)
    await session.start()
    t.emit('peerConnected', { id: 'bbbb2222', session: 's1', role: 'initiator' })
    t.emit('peerDisconnected', { id: 'bbbb2222' })
    expect(session.isConnected('bbbb2222')).toBe(false)
    t.emit('peerConnected', { id: 'bbbb2222', session: 's1', role: 'receiver' })
    expect(session.isConnected('bbbb2222')).toBe(true)
    expect(session.sessionOf('bbbb2222')).toBe('s1')
  })

  it('sendSignal：无通道 NOT_CONNECTED；有通道经 transport 发出', async () => {
    const t = new FakeTransport()
    const session = makeSession(t, {} as never)
    await session.start()
    const r1 = await session.sendSignal('bbbb2222', { kind: 'offer', sdp: 'x' })
    expect(r1).toEqual({ ok: false, error: 'NOT_CONNECTED' })
    t.emit('peerConnected', { id: 'bbbb2222', session: 's1', role: 'receiver' })
    const r2 = await session.sendSignal('bbbb2222', { kind: 'answer', sdp: 'y' })
    expect(r2).toEqual({ ok: true })
    expect(t.calls.filter((c) => c.startsWith('sendMessage:'))).toEqual(['sendMessage:bbbb2222:answer'])
  })

  it('disconnect 清活跃通道并通知原生', async () => {
    const t = new FakeTransport()
    const session = makeSession(t, {} as never)
    await session.start()
    t.emit('peerConnected', { id: 'bbbb2222', session: 's1', role: 'initiator' })
    await session.disconnect('bbbb2222')
    expect(session.isConnected('bbbb2222')).toBe(false)
    expect(t.disconnected).toEqual(['bbbb2222'])
  })
})

describe('事件透传', () => {
  it('messageReceived → onSignal（SignalPayload 同构）', async () => {
    const t = new FakeTransport()
    const signals: Array<{ from: string; kind: string; sdp: string }> = []
    const session = makeSession(t, { onSignal: (f: string, p: { kind: string; sdp: string }) => signals.push({ from: f, ...p }) } as never)
    await session.start()
    t.emit('messageReceived', { from: 'bbbb2222', session: 's1', kind: 'offer', sdp: 'compressed' } as ChannelMessageEvent)
    expect(signals).toEqual([{ from: 'bbbb2222', kind: 'offer', sdp: 'compressed' }])
  })

  it('signalingError → onError(code, message)', async () => {
    const t = new FakeTransport()
    const errors: Array<{ code: string; message: string }> = []
    const session = makeSession(t, { onError: (c: string, m: string) => errors.push({ code: c, message: m }) } as never)
    await session.start()
    t.emit('signalingError', { peerId: 'bbbb2222', code: 'PROTOCOL_VIOLATION', message: '坏帧' } as SignalingErrorEvent)
    expect(errors).toEqual([{ code: 'PROTOCOL_VIOLATION', message: '坏帧' }])
  })

  it('onPeerDisconnected 透传', async () => {
    const t = new FakeTransport()
    const gone: string[] = []
    const session = makeSession(t, { onPeerDisconnected: (id: string) => gone.push(id) } as never)
    await session.start()
    t.emit('peerConnected', { id: 'bbbb2222', session: 's1', role: 'initiator' })
    t.emit('peerDisconnected', { id: 'bbbb2222' })
    expect(gone).toEqual(['bbbb2222'])
  })
})

describe('describeLanError', () => {
  it('映射常见错误码为用户可读文案', () => {
    expect(describeLanError('LOCAL_NETWORK_DENIED')).toContain('本地网络权限')
    expect(describeLanError('PORT_IN_USE')).toContain('端口')
    expect(describeLanError('CONNECTION_REFUSED')).toContain('拒绝')
    expect(describeLanError('CONNECTION_TIMEOUT')).toContain('超时')
    expect(describeLanError('NOT_CONNECTED')).toContain('未连接')
    expect(describeLanError('PROTOCOL_VIOLATION')).toContain('协议错误')
  })

  it('未知码退回原生 message（原生已是中文）', () => {
    expect(describeLanError('WEIRD', '原生消息')).toBe('原生消息')
    expect(describeLanError('WEIRD')).toContain('WEIRD')
  })
})
