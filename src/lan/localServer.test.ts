/**
 * LocalServerSession 单测（ADR-0009 决策 4 / T07）—— 假 transport + 假证书实现注入：
 * 覆盖：CA 持久化（生成/载入/损坏重生成）/ 叶证书按地址重签 / 端口回退 /
 * 事件订阅与信令收发 / wire 消息编解码 / 地址 URL 构建 / 错误回滚。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_CA_KEY,
  LOCAL_CA_KEY_PEM,
  LOCAL_LOOPBACK_IP,
  LocalServerSession,
  localServerUrl,
  makeLocalSignalMessage,
  parseLocalSignalMessage,
  type LocalServerEvents,
  type LocalServerSessionOptions,
  type LocalServerStorage,
  type LocalServerTransport,
} from './localServer'
import { localHostName } from './cert'
import type { SignalPayload } from '../protocol/signaling'

const CA_PEM = '-----BEGIN CERTIFICATE-----\nQUFB\n-----END CERTIFICATE-----'
const CA_KEY_PEM = '-----BEGIN PRIVATE KEY-----\nQkJC\n-----END PRIVATE KEY-----'
const LEAF_PEM = '-----BEGIN CERTIFICATE-----\nQ0ND\n-----END CERTIFICATE-----'
const LEAF_KEY_PEM = '-----BEGIN PRIVATE KEY-----\nRERE\n-----END PRIVATE KEY-----'

const FINGERPRINT = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

const DEVICE = { id: 'dev-1', name: '我的 iPhone', kind: 'phone' as const, port: 9443, ver: '1' }

/** 假证书实现：签名参数可断言（SAN 覆盖） */
function fakeCert() {
  const signLeafCertificate = vi.fn(async (_opts: { dnsName?: string; ipAddresses: string[] }) => {
    return { certPem: LEAF_PEM, keyPem: LEAF_KEY_PEM }
  })
  const createSigningAuthority = vi.fn(async () => ({ caPem: CA_PEM, caKeyPem: CA_KEY_PEM }))
  const fingerprintSha256 = vi.fn(async () => FINGERPRINT)
  const isUsableCa = vi.fn(async () => true)
  return { signLeafCertificate, createSigningAuthority, fingerprintSha256, isUsableCa }
}

/** 假 storage（localStorage 形状） */
function fakeStorage(initial: Record<string, string> = {}): LocalServerStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v
    },
    removeItem: (k) => {
      delete data[k]
    },
  }
}

type TestTransport = LocalServerTransport & { _emit(name: string, e?: unknown): void }

function makeTransport(overrides: Partial<LocalServerTransport> = {}): TestTransport {
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  return {
    getLocalAddresses: async () => ({ addresses: ['10.0.0.5'] }),
    startLocalServer: async () => ({ ok: true, port: 9443, addresses: ['10.0.0.5'] }),
    stopLocalServer: async () => ({ ok: true }),
    sendLocalMessage: async () => ({ ok: true }),
    addListener: async (name, cb) => {
      const arr = listeners.get(name) ?? []
      arr.push(cb as (e: unknown) => void)
      listeners.set(name, arr)
      return {
        remove: () => {
          listeners.set(
            name,
            (listeners.get(name) ?? []).filter((x) => x !== cb),
          )
        },
      }
    },
    _emit(name: string, e?: unknown) {
      for (const cb of listeners.get(name) ?? []) cb(e)
    },
    _listeners: listeners,
    ...overrides,
  } as TestTransport
}

function makeSession(
  transport: LocalServerTransport,
  cert = fakeCert(),
  opts: Partial<LocalServerSessionOptions> = {},
) {
  const events: LocalServerEvents = {
    onClientChange: vi.fn(),
    onSignal: vi.fn(),
    onError: vi.fn(),
  }
  const storage = fakeStorage()
  const session = new LocalServerSession({
    transport,
    device: DEVICE,
    events,
    storage,
    certImpl: cert as never,
    ...opts,
  })
  return { session, events, storage, cert }
}

describe('wire 消息编解码', () => {
  it('makeLocalSignalMessage：{v:1,type:signal,kind,sdp}', () => {
    const text = makeLocalSignalMessage({ kind: 'offer', sdp: 'sdp-abc' })
    expect(JSON.parse(text)).toEqual({ v: 1, type: 'signal', kind: 'offer', sdp: 'sdp-abc' })
  })

  it('parseLocalSignalMessage：合法消息解析为 SignalPayload', () => {
    expect(parseLocalSignalMessage(makeLocalSignalMessage({ kind: 'answer', sdp: 'x' }))).toEqual({
      kind: 'answer',
      sdp: 'x',
    })
  })

  it('parseLocalSignalMessage：非法消息返回 null（坏 JSON/缺字段/错版本）', () => {
    expect(parseLocalSignalMessage('not-json')).toBeNull()
    expect(parseLocalSignalMessage('{"v":2,"type":"signal","kind":"offer","sdp":"x"}')).toBeNull()
    expect(parseLocalSignalMessage('{"v":1,"type":"hello","id":"a"}')).toBeNull()
    expect(parseLocalSignalMessage('{"v":1,"type":"signal","kind":"ice","sdp":"x"}')).toBeNull()
    expect(parseLocalSignalMessage('{"v":1,"type":"signal","kind":"offer","sdp":""}')).toBeNull()
  })
})

describe('地址 URL 构建', () => {
  it('localServerUrl：wss://ip:port/ws?device=<id>', () => {
    expect(localServerUrl('10.0.0.5', 9443, 'dev-1')).toBe('wss://10.0.0.5:9443/ws?device=dev-1')
  })
})

describe('CA 持久化', () => {
  it('首次启动生成并持久化（lt.localCa / lt.localCaKey）', async () => {
    const t = makeTransport()
    const { session, storage, cert } = makeSession(t)
    await session.start()
    expect(cert.createSigningAuthority).toHaveBeenCalledTimes(1)
    expect(storage.data[LOCAL_CA_KEY]).toBe(CA_PEM)
    expect(storage.data[LOCAL_CA_KEY_PEM]).toBe(CA_KEY_PEM)
    expect(session.caPem).toBe(CA_PEM)
    expect(session.caFingerprint).toBe(FINGERPRINT)
    await session.stop()
  })

  it('二次启动复用持久化 CA（不再生成；桌面无需重信任）', async () => {
    const storage = fakeStorage({ [LOCAL_CA_KEY]: CA_PEM, [LOCAL_CA_KEY_PEM]: CA_KEY_PEM })
    const t = makeTransport()
    const cert = fakeCert()
    const session = new LocalServerSession({
      transport: t,
      device: DEVICE,
      events: { onClientChange: vi.fn(), onSignal: vi.fn(), onError: vi.fn() },
      storage,
      certImpl: cert as never,
    })
    await session.start()
    expect(cert.createSigningAuthority).not.toHaveBeenCalled()
    expect(session.caPem).toBe(CA_PEM)
    await session.stop()
  })

  it('CA 损坏（含块但 DER 非法，isUsableCa=false）→ 重新生成并覆盖', async () => {
    const storage = fakeStorage({ [LOCAL_CA_KEY]: 'garbage-----BEGIN CERTIFICATE-----\ngarbage', [LOCAL_CA_KEY_PEM]: 'garbage-----BEGIN PRIVATE KEY-----\ngarbage' })
    const t = makeTransport()
    const cert = fakeCert()
    cert.isUsableCa.mockResolvedValue(false)
    const session = new LocalServerSession({
      transport: t,
      device: DEVICE,
      events: { onClientChange: vi.fn(), onSignal: vi.fn(), onError: vi.fn() },
      storage,
      certImpl: cert as never,
    })
    await session.start()
    expect(cert.isUsableCa).toHaveBeenCalledTimes(1)
    expect(cert.createSigningAuthority).toHaveBeenCalledTimes(1)
    expect(storage.data[LOCAL_CA_KEY]).toBe(CA_PEM)
    await session.stop()
  })
})

describe('启动编排', () => {
  it('叶证书按当前地址重签：SAN = .local + IP + 127.0.0.1', async () => {
    const t = makeTransport()
    const { session, cert } = makeSession(t)
    await session.start()
    expect(cert.signLeafCertificate).toHaveBeenCalledWith({
      caPem: CA_PEM,
      caKeyPem: CA_KEY_PEM,
      dnsName: localHostName('dev-1'),
      ipAddresses: ['10.0.0.5', LOCAL_LOOPBACK_IP],
      commonName: '我的 iPhone',
    })
    await session.stop()
  })

  it('端口被占依次试 9444/9445；全部失败 → PORT_IN_USE + 回滚', async () => {
    let started: number[] = []
    const t = makeTransport({
      startLocalServer: async (o) => {
        started.push(o.device.port)
        if (o.device.port < 9445) return { ok: false, error: 'PORT_IN_USE' }
        return { ok: true, port: 9445, addresses: ['10.0.0.5'] }
      },
    })
    const { session, events } = makeSession(t)
    const r = await session.start()
    expect(r.ok).toBe(true)
    expect(started).toEqual([9443, 9444, 9445])
    expect(session.port).toBe(9445)
    expect(events.onError).not.toHaveBeenCalled()
    await session.stop()

    // 全部失败
    const t2 = makeTransport({
      startLocalServer: async (o) => {
        if (o.device.port === 9443) return { ok: false, error: 'PORT_IN_USE' }
        if (o.device.port === 9444) return { ok: false, error: 'PORT_IN_USE' }
        return { ok: false, error: 'PORT_IN_USE' }
      },
    })
    const s2 = makeSession(t2)
    const r2 = await s2.session.start()
    expect(r2.ok).toBe(false)
    expect(r2.error).toBe('PORT_IN_USE')
    expect(s2.events.onError).toHaveBeenCalledWith('PORT_IN_USE', expect.stringContaining('9443'))
    expect(s2.session.running).toBe(false)
  })

  it('无局域网地址 → ADDRESS_FAILED（Wi-Fi 断开场景）', async () => {
    const t = makeTransport({ getLocalAddresses: async () => ({ addresses: [] }) })
    const { session, events } = makeSession(t)
    const r = await session.start()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('ADDRESS_FAILED')
    expect(events.onError).toHaveBeenCalledWith('ADDRESS_FAILED', expect.any(String))
  })

  it('地址过滤：回环/link-local/非 IPv4 不进入 SAN', async () => {
    const t = makeTransport({
      getLocalAddresses: async () => ({ addresses: ['10.0.0.5', '127.0.0.1', '169.254.1.1', 'fe80::1'] }),
    })
    const { session, cert } = makeSession(t)
    await session.start()
    expect(cert.signLeafCertificate.mock.calls[0][0].ipAddresses).toEqual(['10.0.0.5', '127.0.0.1'])
    expect(session.urls()).toEqual(['wss://10.0.0.5:9443/ws?device=dev-1'])
    await session.stop()
  })

  it('持久化 CA 密钥损坏（signLeaf 首次抛错）→ 清库重生成重试一次成功', async () => {
    const storage = fakeStorage({ [LOCAL_CA_KEY]: CA_PEM, [LOCAL_CA_KEY_PEM]: CA_KEY_PEM })
    const t = makeTransport()
    const cert = fakeCert()
    cert.signLeafCertificate.mockRejectedValueOnce(new Error('bad key DER'))
    const session = new LocalServerSession({
      transport: t,
      device: DEVICE,
      events: { onClientChange: vi.fn(), onSignal: vi.fn(), onError: vi.fn() },
      storage,
      certImpl: cert as never,
    })
    const r = await session.start()
    expect(r.ok).toBe(true)
    expect(cert.createSigningAuthority).toHaveBeenCalledTimes(1) // 重试时重新生成 CA
    expect(storage.data[LOCAL_CA_KEY]).toBe(CA_PEM) // 新 CA 已持久化
    await session.stop()
  })

  it('网络变更（地址轮询检测）→ 自动重签并重启服务器（SAN 覆盖新 IP）', async () => {
    vi.useFakeTimers()
    try {
      let addresses = ['10.0.0.5']
      const startCalls: number[] = []
      const t = makeTransport({
        getLocalAddresses: async () => ({ addresses }),
        startLocalServer: async (o) => {
          startCalls.push(o.device.port)
          return { ok: true, port: 9443, addresses }
        },
      })
      const { session, cert, events } = makeSession(t, undefined, { addressPollMs: 1000 })
      await session.start()
      expect(cert.signLeafCertificate).toHaveBeenCalledTimes(1)
      expect(session.urls()).toEqual(['wss://10.0.0.5:9443/ws?device=dev-1'])
      // DHCP 换 IP → 轮询检测到变化 → 重签（新 SAN）+ 重启
      addresses = ['10.0.0.99']
      await vi.advanceTimersByTimeAsync(1000)
      expect(cert.signLeafCertificate).toHaveBeenCalledTimes(2)
      const lastCall = cert.signLeafCertificate.mock.calls[1][0]
      expect(lastCall.ipAddresses).toEqual(['10.0.0.99', LOCAL_LOOPBACK_IP])
      expect(session.urls()).toEqual(['wss://10.0.0.99:9443/ws?device=dev-1'])
      expect(startCalls.length).toBeGreaterThanOrEqual(2)
      expect(events.onClientChange).toHaveBeenCalledWith(false)
      await session.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('启动失败（非端口类错误）→ 回滚 + onError', async () => {
    const t = makeTransport({
      startLocalServer: async () => ({ ok: false, error: 'TLS_SETUP_FAILED' }),
    })
    const { session, events } = makeSession(t)
    const r = await session.start()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('TLS_SETUP_FAILED')
    expect(events.onError).toHaveBeenCalledWith('TLS_SETUP_FAILED', expect.stringContaining('TLS_SETUP_FAILED'))
    expect(session.running).toBe(false)
  })
})

describe('信令中继', () => {
  it('桌面消息 → onSignal（wire → SignalPayload）', async () => {
    const t = makeTransport()
    const { session, events } = makeSession(t)
    await session.start()
    t._emit('localClientConnected')
    expect(events.onClientChange).toHaveBeenCalledWith(true)
    t._emit('localMessageReceived', { message: makeLocalSignalMessage({ kind: 'offer', sdp: 'S' }) })
    expect(events.onSignal).toHaveBeenCalledWith({ kind: 'offer', sdp: 'S' })
    t._emit('localClientDisconnected')
    expect(events.onClientChange).toHaveBeenCalledWith(false)
    await session.stop()
  })

  it('非法桌面消息丢弃（不触发 onSignal）', async () => {
    const t = makeTransport()
    const { session, events } = makeSession(t)
    await session.start()
    t._emit('localMessageReceived', { message: 'garbage' })
    expect(events.onSignal).not.toHaveBeenCalled()
    await session.stop()
  })

  it('sendSignal：无客户端 → NO_CLIENT；有客户端 → wire 消息发出', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const t = makeTransport({ sendLocalMessage: send })
    const { session } = makeSession(t)
    await session.start()
    const before = await session.sendSignal({ kind: 'answer', sdp: 'S' })
    expect(before.ok).toBe(false)
    expect(before.error).toBe('NO_CLIENT')
    t._emit('localClientConnected')
    const after = await session.sendSignal({ kind: 'answer', sdp: 'S' } as SignalPayload)
    expect(after.ok).toBe(true)
    expect(send).toHaveBeenCalledWith({ message: makeLocalSignalMessage({ kind: 'answer', sdp: 'S' }) })
    await session.stop()
  })
})