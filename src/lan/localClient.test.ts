/**
 * LocalServerClient 单测（T08 电脑端 B / SPEC §5.6）—— 假 socket + 假 fetchInfo + 假 storage 注入：
 * 覆盖：地址解析（完整 wss / 裸 ip:port / https:// / 非法）/ 持久化（记住/读取/清除）/
 * 连接生命周期（fetch 设备信息 → open → connected）／信令收发（wire 同构）/
 * 自动重连退避（断开 → reconnecting → 重连；attempts 归零）／放弃转 offline（迟到事件不复活）/
 * retry 手动恢复／裸地址失败与恢复／close 清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_DESKTOP_PEER_ID,
  LOCAL_SERVER_KEY,
  LocalServerClient,
  buildLocalWsUrl,
  clearSavedLocalServer,
  getSavedLocalServer,
  parseLocalServerUrl,
  saveLocalServer,
  type LocalClientState,
  type LocalDeviceInfo,
} from './localClient'
import type { LocalServerStorage } from './localServer'
import type { SignalingSocket } from '../signaling/client'
import type { SignalPayload } from '../protocol/signaling'
import { makeLocalSignalMessage } from './localServer'

/** 可注入的假 socket：记录发送内容、可手动触发事件（与 reconnect.test 同构） */
interface FakeSocket extends SignalingSocket {
  sent: string[]
  closed: boolean
  url: string
  fire(ev: 'open' | 'message' | 'close' | 'error', data?: string): void
}

function socketHarness() {
  const sockets: FakeSocket[] = []
  const createSocket = (url: string): SignalingSocket => {
    const handlers: Record<string, ((data?: string) => void) | undefined> = {}
    const s: FakeSocket = {
      url,
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

/** 假设备信息获取：记录请求基址、可注入失败 */
function fetchHarness(device: LocalDeviceInfo = { id: 'dev-1', name: '我的 iPhone', kind: 'phone', port: 9443 }) {
  const requestedBases: string[] = []
  const fn = vi.fn(async (base: string): Promise<LocalDeviceInfo> => {
    requestedBases.push(base)
    return device
  })
  return { fn, requestedBases }
}

/** 冲刷微任务：connect() 先取设备信息（异步）再建 socket */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
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

const FULL_URL = 'wss://10.0.0.5:9443/ws?device=dev-1'
const BARE_URL = '10.0.0.5:9443'

function setup(overrides: Partial<ConstructorParameters<typeof LocalServerClient>[0]> = {}) {
  const { sockets, createSocket } = socketHarness()
  const fetchInfo = fetchHarness()
  const states: LocalClientState[] = []
  const devices: (LocalDeviceInfo | null)[] = []
  const signals: SignalPayload[] = []
  const errors: string[] = []
  const client = new LocalServerClient({
    createSocket,
    fetchInfo: fetchInfo.fn,
    events: {
      onState: (s) => states.push(s),
      onDevice: (d) => devices.push(d),
      onSignal: (p) => signals.push(p),
      onError: (m) => errors.push(m),
    },
    ...overrides,
  })
  return { sockets, createSocket, fetchInfo, client, states, devices, signals, errors }
}


beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('地址解析 parseLocalServerUrl', () => {
  it('完整 wss 地址（app 复制即用）：host/port/deviceId 齐全', () => {
    const p = parseLocalServerUrl(FULL_URL)
    expect(p).toEqual({
      infoBase: 'https://10.0.0.5:9443/',
      host: '10.0.0.5',
      port: 9443,
      wsUrl: FULL_URL,
      deviceId: 'dev-1',
    })
  })

  it('`.local` 主机名（DHCP 换 IP 免重签路径）完整地址', () => {
    const p = parseLocalServerUrl('wss://xiaodingdangdeMacBook.local:9443/ws?device=dev-1')
    expect(p?.host).toBe('xiaodingdangdeMacBook.local')
    expect(p?.deviceId).toBe('dev-1')
    expect(p?.infoBase).toBe('https://xiaodingdangdeMacBook.local:9443/')
  })

  it('裸 ip:port（无 /ws?device → deviceId 缺省，由 GET / 补）', () => {
    const p = parseLocalServerUrl(BARE_URL)
    expect(p).toEqual({ infoBase: 'https://10.0.0.5:9443/', host: '10.0.0.5', port: 9443 })
  })

  it('https:// 基址输入（无 deviceId；同裸地址语义）', () => {
    const p = parseLocalServerUrl('https://10.0.0.5:9443/')
    expect(p).toEqual({ infoBase: 'https://10.0.0.5:9443/', host: '10.0.0.5', port: 9443 })
  })

  it('非法：缺端口 / 明文 ws&http / 杂物 → null', () => {
    expect(parseLocalServerUrl('wss://10.0.0.5')).toBeNull() // 无端口
    expect(parseLocalServerUrl('ws://10.0.0.5:9443/ws?device=x')).toBeNull() // 明文 ws（mixed content 硬拦）
    expect(parseLocalServerUrl('http://10.0.0.5:9443')).toBeNull()
    expect(parseLocalServerUrl('')).toBeNull()
    expect(parseLocalServerUrl('随便输的')).toBeNull()
    expect(parseLocalServerUrl('10.0.0.5:99999')).toBeNull() // 端口超界
  })

  it('buildLocalWsUrl：与 app 侧 localServerUrl 同构', () => {
    expect(buildLocalWsUrl(parseLocalServerUrl(BARE_URL)!, 'dev-1')).toBe(FULL_URL)
  })
})

describe('持久化 lt.localServer', () => {
  it('记住 / 读取 / 清除', () => {
    const storage = fakeStorage()
    expect(getSavedLocalServer(storage)).toBe('')
    saveLocalServer(FULL_URL, storage)
    expect(storage.data[LOCAL_SERVER_KEY]).toBe(FULL_URL)
    expect(getSavedLocalServer(storage)).toBe(FULL_URL)
    clearSavedLocalServer(storage)
    expect(getSavedLocalServer(storage)).toBe('')
  })
})

describe('连接生命周期', () => {
  it('完整地址：fetch 设备信息（补名称）→ open → connected', async () => {
    const { sockets, client, states, devices, fetchInfo } = setup()
    client.connect(FULL_URL)
    await flushMicrotasks()
    expect(states.at(-1)).toBe('connecting')
    expect(fetchInfo.requestedBases).toEqual(['https://10.0.0.5:9443/'])
    expect(devices.at(-1)).toEqual({ id: 'dev-1', name: '我的 iPhone', kind: 'phone', port: 9443 })
    expect(sockets[0].url).toBe(FULL_URL)
    sockets[0].fire('open')
    expect(states.at(-1)).toBe('connected')
    expect(client.state).toBe('connected')
    expect(client.device?.id).toBe('dev-1')
    expect(client.wsUrl).toBe(FULL_URL)
    client.close()
  })

  it('裸地址：GET / 取到 id 后拼完整 wss 地址再连接', async () => {
    const { sockets, client } = setup()
    client.connect(BARE_URL)
    await flushMicrotasks()
    expect(sockets[0].url).toBe(FULL_URL) // 拼接结果
    sockets[0].fire('open')
    expect(client.state).toBe('connected')
    client.close()
  })

  it('完整地址但 GET / 失败（信息端点异常）→ 用 URL id 兜底名称继续连接', async () => {
    const { fn: fetchInfo } = fetchHarness()
    fetchInfo.mockRejectedValue(new Error('Failed to fetch'))
    const { sockets, client, devices, errors } = setup({ fetchInfo })
    client.connect(FULL_URL)
    await flushMicrotasks()
    expect(errors).toEqual([]) // 不阻塞
    expect(devices.at(-1)).toEqual({ id: 'dev-1', name: '局域网设备', kind: 'other', port: 9443 })
    expect(sockets[0].url).toBe(FULL_URL)
    expect(client.state).toBe('connecting')
    sockets[0].fire('open')
    expect(client.state).toBe('connected')
    client.close()
  })

  it('裸地址且 GET / 失败 → 明确错误转 offline（无设备 id 无法拼地址）', async () => {
    const fetchInfo = vi.fn(async (): Promise<LocalDeviceInfo> => {
      throw new Error('Failed to fetch')
    })
    const { sockets, client, errors, states } = setup({ fetchInfo })
    client.connect(BARE_URL)
    await flushMicrotasks()
    expect(states.at(-1)).toBe('offline')
    expect(errors[0]).toContain('无法获取手机设备信息')
    expect(sockets).toHaveLength(0) // 未拼出地址，从未建 socket
    expect(client.state).toBe('offline')
    // retry：重新取设备信息 → 这次成功 → 继续连接
    fetchInfo.mockResolvedValueOnce({ id: 'dev-1', name: '我的 iPhone', kind: 'phone', port: 9443 })
    client.retry()
    await flushMicrotasks()
    expect(states.at(-1)).toBe('connecting')
    sockets[0].fire('open')
    expect(client.state).toBe('connected')
    client.close()
  })

  it('非法地址：onError 且不建 socket', () => {
    const { sockets, client, errors } = setup()
    client.connect('不合法')
    expect(errors[0]).toContain('地址格式不正确')
    expect(sockets).toHaveLength(0)
    expect(client.state).toBe('idle')
    client.close()
  })

  it('信令收发：wire 消息与 LocalServerSession 同构（kind/sdp 压缩态透明）', async () => {
    const { sockets, client } = setup()
    client.connect(FULL_URL)
    await flushMicrotasks()
    sockets[0].fire('open')
    // 发：connected 时 send wire 帧；未连接时静默丢弃
    client.signal({ kind: 'offer', sdp: 'S' })
    expect(sockets[0].sent).toEqual([makeLocalSignalMessage({ kind: 'offer', sdp: 'S' })])
    client.close()
    client.signal({ kind: 'answer', sdp: 'X' }) // close 后丢弃
    expect(sockets[0].sent).toHaveLength(1)
    // 收：合法帧 → onSignal；坏帧忽略
    const { sockets: s2, client: c2, signals: sig2 } = setup()
    c2.connect(FULL_URL)
    await flushMicrotasks()
    s2[0].fire('open')
    s2[0].fire('message', makeLocalSignalMessage({ kind: 'answer', sdp: 'R' }))
    expect(sig2).toEqual([{ kind: 'answer', sdp: 'R' }])
    s2[0].fire('message', 'garbage')
    expect(sig2).toHaveLength(1)
    c2.close()
  })

  it('第一次连接前收到 message（连接中）→ onSignal 仍分发给调用方', async () => {
    const { sockets, client, signals } = setup()
    client.connect(FULL_URL)
    await flushMicrotasks()
    sockets[0].fire('message', makeLocalSignalMessage({ kind: 'offer', sdp: 'S' }))
    expect(signals).toEqual([{ kind: 'offer', sdp: 'S' }])
    client.close()
  })
})

describe('自动重连', () => {
  it('断开 → reconnecting → 退避后重连 → open 后 attempts 归零', async () => {
    const { sockets, client, states } = setup({ initialDelayMs: 1000, maxDelayMs: 2000, maxAttempts: 3 })
    client.connect(FULL_URL)
    await flushMicrotasks()
    sockets[0].fire('open')
    expect(states.at(-1)).toBe('connected')
    sockets[0].fire('close')
    expect(states.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2) // 重连建了新 socket（同一地址）
    expect(sockets[1].url).toBe(FULL_URL)
    sockets[1].fire('open')
    expect(states.at(-1)).toBe('connected')
    client.close()
  })

  it('退避翻倍 1s→2s；error 与 close 双事件只排程一次', async () => {
    const { sockets, client, states } = setup({ initialDelayMs: 1000 })
    client.connect(FULL_URL)
    await flushMicrotasks()
    sockets[0].fire('error')
    sockets[0].fire('close') // 同一失败双事件
    expect(states.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(999)
    expect(sockets).toHaveLength(1) // 未到 1s 无新连接
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(2)
    sockets[1].fire('close')
    expect(states.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets).toHaveLength(3) // 第二次退避 2s
    client.close()
  })

  it('连续失败超上限 → offline + 明确错误；迟到事件不复活；retry() 手动恢复', async () => {
    const { sockets, client, states, errors } = setup({ initialDelayMs: 1000, maxDelayMs: 1000, maxAttempts: 2 })
    client.connect(FULL_URL)
    await flushMicrotasks()
    sockets[0].fire('close') // attempts=1 → 重连
    await vi.advanceTimersByTimeAsync(1000)
    sockets[1].fire('close') // attempts=2 → 重连
    await vi.advanceTimersByTimeAsync(1000)
    sockets[2].fire('close') // attempts=3 > 2 → 放弃转 offline
    expect(states.at(-1)).toBe('offline')
    expect(errors[0]).toContain('连接失败（多次重试）')
    expect(client.state).toBe('offline')
    // 迟到事件不得复活自动重连（offline 守卫）
    const before = sockets.length
    sockets[2].fire('close')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sockets).toHaveLength(before)
    // retry：重置计数立即重连（wsUrl 已就绪，open 同步建 socket）
    client.retry()
    expect(states.at(-1)).toBe('connecting')
    sockets[before].fire('open')
    expect(client.state).toBe('connected')
    // 之后断开仍按新一轮自动重连（attempts 已归零）
    sockets[before].fire('close')
    expect(states.at(-1)).toBe('reconnecting')
    client.close()
  })

  it('换地址重连：connect 二次调用关旧 socket、重置失败计数', async () => {
    const fetchInfo = vi.fn(async (_base: string) => ({ id: 'dev-2', name: 'iPad', kind: 'tablet', port: 9444 }))
    const { sockets, client, devices } = setup({ fetchInfo })
    client.connect(FULL_URL)
    await flushMicrotasks()
    sockets[0].fire('open')
    client.connect('wss://10.0.0.6:9444/ws?device=dev-2')
    await flushMicrotasks()
    expect(sockets[0].closed).toBe(true) // 旧连接已关
    expect(sockets[1].url).toBe('wss://10.0.0.6:9444/ws?device=dev-2')
    expect(devices.at(-1)).toEqual({ id: 'dev-2', name: 'iPad', kind: 'tablet', port: 9444 })
    sockets[1].fire('close') // 失败计数从新地址重新开始
    expect(client.state).toBe('reconnecting')
    client.close()
  })

  it('close()：清定时器、关 socket、清设备、停自动重连', async () => {
    const { sockets, client, devices, states } = setup()
    client.connect(FULL_URL)
    await flushMicrotasks()
    sockets[0].fire('open')
    client.close()
    expect(sockets[0].closed).toBe(true)
    expect(devices.at(-1)).toBeNull()
    expect(states.at(-1)).toBe('idle')
    expect(client.device).toBeNull()
    expect(client.state).toBe('idle')
    // close 后旧 socket 事件不得触发任何状态
    sockets[0].fire('close')
    expect(client.state).toBe('idle')
  })

  it('连接代际守卫：慢 GET / 的迟到结果不覆盖新地址（connect 被替换）', async () => {
    // 第一个地址的 fetch 挂起（deferred），第二个地址立即返回
    let releaseSlow: (v: LocalDeviceInfo) => void = () => {}
    const slowFetch = new Promise<LocalDeviceInfo>((res) => {
      releaseSlow = res
    })
    const fetchInfo = vi.fn((base: string) => {
      if (base === 'https://10.0.0.5:9443/') return slowFetch // A 慢
      return Promise.resolve({ id: 'dev-2', name: 'iPad', kind: 'tablet', port: 9444 }) // B 快
    })
    const { sockets, client } = setup({ fetchInfo })
    client.connect('wss://10.0.0.5:9443/ws?device=dev-1') // A
    await flushMicrotasks()
    client.connect('wss://10.0.0.7:9444/ws?device=dev-2') // B：替换 A
    await flushMicrotasks()
    expect(client.device?.id).toBe('dev-2')
    // A 的 fetch 未完成从未建 socket；B 是第一个 socket
    expect(sockets[0].url).toBe('wss://10.0.0.7:9444/ws?device=dev-2')
    // A 的慢 fetch 迟到返回 → 必须被丢弃（不得覆盖 device/wsUrl、不得建 A 的 socket）
    releaseSlow({ id: 'dev-1', name: '我的 iPhone', kind: 'phone', port: 9443 })
    await flushMicrotasks()
    expect(client.device?.id).toBe('dev-2')
    expect(client.wsUrl).toBe('wss://10.0.0.7:9444/ws?device=dev-2')
    expect(sockets).toHaveLength(1) // 无 A 的迟到 socket
    client.close()
  })
})

describe('对端身份常量', () => {
  it('LOCAL_DESKTOP_PEER_ID：app 端视角的桌面对端（单客户端）', () => {
    expect(LOCAL_DESKTOP_PEER_ID).toBe('local-server-desktop')
  })
})