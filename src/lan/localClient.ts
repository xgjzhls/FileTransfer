/**
 * LocalServerClient —— 桌面 Chrome 本地服务器信令客户端（T08 电脑端 B，ADR-0009 决策 5）。
 *
 * LocalServerSession（app 侧，T07）的浏览器端对偶：桌面上没有原生插件可用
 * （web 降级明确拒绝，见 plugins/lan-discovery/src/web.ts），全部用浏览器能力：
 *
 * - **地址解析**：接受 app 界面展示的完整地址 `wss://<ip>:<port>/ws?device=<id>`
 *   （复制即用），也接受裸 `ip:port` / `https://<ip>:<port>` —— 后者先取
 *   `GET /`（设备信息 JSON，含 id）再拼出完整 wss 地址
 * - **记住**：连接成功后存 `lt.localServer`；重开页面自动重连（SPEC §5.6）
 * - **自动重连**：WS 断开 → 指数退避（1s→2s→4s…封顶 10s）自动重连；
 *   连续失败超过上限 → offline（明确错误 + 提示重输地址，DHCP 换 IP 场景）
 * - **设备信息**：`GET https://<base>/` 取 {name,id,kind,port}，供设备列表展示；
 *   失败（证书未受信 / app 未开）→ 用 URL 里的 deviceId 兜底名称
 * - **信令**：wire 与 LocalServerSession 同构（SPEC §5.6）：客户端连
 *   `wss://<addr>/ws?device=<id>` 后收发 UTF-8 JSON 文本帧
 *   `{v:1,type:'signal',kind,sdp}`（sdp = gzip+base64url，与 WS/QR 同压缩约定）；
 *   sdp 由调用方（ConnectionManager/RtcPeer）直接给出压缩态，本模块透明转发
 *
 * createSocket 可注入（测试用假 socket；生产 = createBrowserSocket）。
 * 纯 JS、无 @capacitor 依赖——与 lanSession.ts / localServer.ts 同一纪律。
 */

import type { SignalPayload } from '../protocol/signaling'
import type { SignalingSocket } from '../signaling/client'
import { makeLocalSignalMessage, parseLocalSignalMessage } from './localServer'
import { defaultStorage, type LocalServerStorage } from './localServer'

/** 连接状态（与 ReconnectingSignalingClient 同词汇；offline = 连续失败放弃自动重连） */
export type LocalClientState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline'

/** 设备信息（GET / 载荷；kind/ver 由 app 上报） */
export interface LocalDeviceInfo {
  id: string
  name: string
  kind: string
  port: number
}

/** app 端视角的桌面对端身份（本地服务器单客户端，无桌面标识；配对状态键用） */
export const LOCAL_DESKTOP_PEER_ID = 'local-server-desktop'

/** 地址持久化键（SPEC §5.6「输一次存 lt.localServer」） */
export const LOCAL_SERVER_KEY = 'lt.localServer'

/** 解析结果：完整 wss 地址（可能缺 deviceId → 需先取 GET / 补） */
export interface ParsedLocalServerUrl {
  /** 信息端点基址（https://<ip>:<port>/，取设备信息用） */
  infoBase: string
  host: string
  port: number
  /** 完整 wss 连接地址（无 /ws?device 输入时暂缺，取到 deviceId 后拼） */
  wsUrl?: string
  /** URL 携带的设备 id（裸地址输入时缺省） */
  deviceId?: string
}

const WSS_PATTERN = /^wss:\/\/([^/?#]+)(\/ws\?device=([^&\s/]+))?/i
const HTTPS_PATTERN = /^https:\/\/([^/?#]+)/i
const BARE_PATTERN = /^([^/?#:\s]+)(?::(\d{1,5}))$/i

/** 解析用户输入的地址；非法返回 null（裸 host 不带端口视为非法，端口必须） */
export function parseLocalServerUrl(input: string): ParsedLocalServerUrl | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  let m = WSS_PATTERN.exec(raw)
  if (m) {
    const [host, portStr] = splitHostPort(m[1])
    const port = portStr ? Number(portStr) : NaN
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null
    const wsUrl = raw.replace(/\/$/, '') // 去掉末尾斜杠（若用户手输）
    return {
      infoBase: `https://${m[1]}/`,
      host,
      port,
      wsUrl,
      deviceId: m[3] || undefined,
    }
  }
  m = HTTPS_PATTERN.exec(raw)
  if (m) {
    const [host, portStr] = splitHostPort(m[1])
    const port = portStr ? Number(portStr) : NaN
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null
    return { infoBase: `https://${m[1]}/`, host, port }
  }
  m = BARE_PATTERN.exec(raw)
  if (m) {
    const port = Number(m[2])
    if (port < 1 || port > 65535) return null
    return { infoBase: `https://${m[1]}:${port}/`, host: m[1], port }
  }
  return null
}

/** host[:port] 拆分（IPv6 方括号保留 host 原样） */
function splitHostPort(authority: string): [string, string | undefined] {
  const idx = authority.lastIndexOf(':')
  if (idx === -1) return [authority, undefined]
  return [authority.slice(0, idx), authority.slice(idx + 1)]
}

/** 由解析结果 + 设备 id 拼完整 wss 地址（与 app 侧 localServerUrl 同构） */
export function buildLocalWsUrl(parsed: ParsedLocalServerUrl, deviceId: string): string {
  return `wss://${parsed.host}:${parsed.port}/ws?device=${encodeURIComponent(deviceId)}`
}

// ---------------------------------------------------------------------------
// 持久化（SPEC §5.6「输一次存 lt.localServer，重开自动重连」）
// storage 形状与默认实现复用 localServer.ts（T08 评审去重：单一实现）
// ---------------------------------------------------------------------------

/** 上次成功连接的地址；无则空串 */
export function getSavedLocalServer(storage: LocalServerStorage = defaultStorage()): string {
  return storage.getItem(LOCAL_SERVER_KEY) ?? ''
}

/** 连接成功后记住地址（重开页面自动重连） */
export function saveLocalServer(url: string, storage: LocalServerStorage = defaultStorage()): void {
  storage.setItem(LOCAL_SERVER_KEY, url)
}

/** 忘记地址（断开 + 清除记忆） */
export function clearSavedLocalServer(storage: LocalServerStorage = defaultStorage()): void {
  storage.removeItem(LOCAL_SERVER_KEY)
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface LocalClientEvents {
  /** 连接状态变化（UI：连接中 / 已连接 / 重连中 / 离线） */
  onState(state: LocalClientState): void
  /** 设备信息就绪 / 清除（null = 断开或从未连接） */
  onDevice(device: LocalDeviceInfo | null): void
  /** 收到 app 发来的信令（SignalPayload，与 WS/QR 同构） */
  onSignal(payload: SignalPayload): void
  /** 错误（连接失败 / 地址非法 / 设备信息获取失败等） */
  onError(message: string): void
}

export interface LocalServerClientOptions {
  /** 每次连接前创建底层 socket（浏览器 WebSocket / 测试假 socket） */
  createSocket(url: string): SignalingSocket
  events: LocalClientEvents
  /** 设备信息获取（默认 fetch GET /；测试注入假实现） */
  fetchInfo?: (base: string) => Promise<LocalDeviceInfo>
  /** 初始退避延迟（ms），默认 1000 */
  initialDelayMs?: number
  /** 退避封顶（ms），默认 10000 */
  maxDelayMs?: number
  /** 自动重连次数上限（达到后放弃、转 offline），默认 5 */
  maxAttempts?: number
}

/** 默认设备信息获取：GET https://<base>/（与 app 服务器 / 端点载荷一致） */
export async function fetchLocalDeviceInfo(base: string): Promise<LocalDeviceInfo> {
  const res = await fetch(base, { cache: 'no-store' })
  if (!res.ok) throw new Error(`device info → ${res.status}`)
  const json = (await res.json()) as Partial<LocalDeviceInfo>
  if (typeof json.id !== 'string' || json.id === '') {
    throw new Error('device info 缺 id')
  }
  return {
    id: json.id,
    name: typeof json.name === 'string' ? json.name : '局域网设备',
    kind: typeof json.kind === 'string' ? json.kind : 'other',
    port: typeof json.port === 'number' ? json.port : 0,
  }
}

export class LocalServerClient {
  private readonly createSocket: (url: string) => SignalingSocket
  private readonly events: LocalClientEvents
  private readonly fetchInfo: (base: string) => Promise<LocalDeviceInfo>
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number

  private socket: SignalingSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 连续失败次数（每次成功 open 归零） */
  private attempts = 0
  /** 连接代际：connect/close 递增——在途 GET / 的迟到结果不得覆盖新地址（评审修正） */
  private epoch = 0
  /** true = 主动关闭或从未连接（不自动重连） */
  private closed = true
  private _state: LocalClientState = 'idle'
  private _device: LocalDeviceInfo | null = null
  /** 本次连接的解析结果（重连复用；不重建） */
  private parsed: ParsedLocalServerUrl | null = null
  /** 当前完整 wss 地址（connected 后由 Home 存 lt.localServer） */
  private _wsUrl = ''

  constructor(options: LocalServerClientOptions) {
    this.createSocket = options.createSocket
    this.events = options.events
    this.fetchInfo = options.fetchInfo ?? fetchLocalDeviceInfo
    this.initialDelayMs = options.initialDelayMs ?? 1_000
    this.maxDelayMs = options.maxDelayMs ?? 10_000
    this.maxAttempts = options.maxAttempts ?? 5
  }

  get state(): LocalClientState {
    return this._state
  }

  /** 当前设备信息（null = 未连接） */
  get device(): LocalDeviceInfo | null {
    return this._device
  }

  /** 当前完整 wss 地址（connected 后存 lt.localServer 用） */
  get wsUrl(): string {
    return this._wsUrl
  }

  /**
   * 连接本地服务器。可重复调用（切换地址：关旧连接、重置退避）。
   * 流程：解析地址 → 取设备信息（缺 id 时必须；有 id 时失败不阻塞）→
   * 拼完整 wss 地址 → 连接；断开后自动退避重连。
   */
  connect(input: string): void {
    const parsed = parseLocalServerUrl(input)
    if (!parsed) {
      this.events.onError('地址格式不正确：请从 app 首页「电脑端连接」复制完整地址（wss://主机:端口/ws?device=…）')
      return
    }
    this.close()
    this.epoch++
    this.attempts = 0
    this.parsed = parsed
    this.closed = false
    this.setState('connecting')
    void this.resolveDevice(parsed)
  }

  /** 手动重连（offline 态恢复）：重置失败计数后立即连接（复用已解析地址） */
  retry(): void {
    if (this.closed || !this.parsed) return
    this.attempts = 0
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this._wsUrl) this.open()
    else void this.resolveDevice(this.parsed) // 裸地址输入：重取设备信息
  }

  /** 经本地服务器发信令（offer/answer；未连接时静默丢弃——断线重连后会重新发起） */
  signal(payload: SignalPayload): void {
    if (this._state !== 'connected' || !this.socket) return
    this.socket.send(makeLocalSignalMessage(payload))
  }

  /** 主动关闭：清定时器、关底层 socket、清设备信息、不再自动重连 */
  close(): void {
    this.closed = true
    this.epoch++
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.socket?.close()
    this.socket = null
    this.parsed = null
    this._wsUrl = ''
    if (this._device !== null) {
      this._device = null
      this.events.onDevice(null)
    }
    this.setState('idle')
  }

  // -------------------------------------------------------------------------

  /**
   * 解析后的地址 → 设备信息。
   * - 缺 deviceId（裸 ip:port / https:// 输入）：GET / 必取，失败 = 无法连接
   * - 有 deviceId（完整 wss 地址）：先用 URL id 建兜底设备，GET / 仅用于补名称
   *   （失败不阻塞连接——服务器可能只开 /ws 而信息端点异常）
   */
  private async resolveDevice(parsed: ParsedLocalServerUrl): Promise<void> {
    const epoch = this.epoch // 代际守卫：期间被 connect/close 替换 → 丢弃本次结果
    let device: LocalDeviceInfo | null = null
    try {
      device = await this.fetchInfo(parsed.infoBase)
    } catch (e) {
      if (epoch !== this.epoch) return
      if (!parsed.deviceId) {
        // 裸地址输入：没有设备 id 就无法拼 wss 地址 → 明确失败
        this.giveUp(
          `无法获取手机设备信息（${e instanceof Error ? e.message : String(e)}）：请确认手机 App 首页「电脑端连接」正在运行、`
          + `手机与电脑在同一 Wi-Fi；首次使用需先运行 scripts/trust-local-ca.sh 信任证书，然后从 App 复制完整地址。`,
        )
        return
      }
      device = {
        id: parsed.deviceId,
        name: '局域网设备',
        kind: 'other',
        port: parsed.port,
      }
    }
    if (epoch !== this.epoch) return // 迟到结果（新 connect/close 已发生）丢弃
    this._device = device
    this.events.onDevice(device)
    this._wsUrl = parsed.wsUrl ?? buildLocalWsUrl(parsed, device.id)
    this.open()
  }

  private open(): void {
    if (this.closed || !this._wsUrl) return
    this.setState('connecting')
    const socket = this.createSocket(this._wsUrl)
    this.socket = socket
    socket.on('message', (data) => {
      if (this.closed || socket !== this.socket) return
      const payload = parseLocalSignalMessage(data ?? '')
      if (payload) this.events.onSignal(payload)
    })
    socket.on('open', () => {
      if (this.closed || socket !== this.socket) return
      this.attempts = 0
      this.setState('connected')
    })
    socket.on('error', () => {
      if (this.closed || socket !== this.socket) return
      this.fail()
    })
    socket.on('close', () => {
      if (this.closed || socket !== this.socket) return
      this.fail()
    })
  }

  /** 一次连接失败：error/close 双事件只排程一次退避；达到上限 → 放弃（offline）。
   * offline 后旧 socket 的迟到事件不得复活自动重连（_state 守卫）。
   */
  private fail(): void {
    if (this.closed || this._state === 'offline' || this.timer !== null) return
    this.socket?.close()
    this.attempts++
    if (this.attempts > this.maxAttempts) {
      this.giveUp(
        '连接失败（多次重试）：请确认手机 App 首页「电脑端连接」正在运行、手机与电脑在同一 Wi-Fi；'
        + '首次使用需先运行 scripts/trust-local-ca.sh 信任证书；若 IP 已变（DHCP）请重新输入地址。',
      )
      return
    }
    const delay = Math.min(this.initialDelayMs * 2 ** (this.attempts - 1), this.maxDelayMs)
    this.setState('reconnecting')
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, delay)
  }

  /** 放弃自动重连（转 offline）：收尾 socket + 统一错误出口；retry() 仍可手动恢复 */
  private giveUp(message: string): void {
    this.socket?.close()
    this.socket = null
    this.setState('offline')
    this.events.onError(message)
  }

  private setState(state: LocalClientState): void {
    if (state === this._state) return
    this._state = state
    this.events.onState(state)
  }
}
