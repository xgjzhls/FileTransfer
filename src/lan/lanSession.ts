/**
 * LanDiscoverySession —— app↔app 局域网发现会话（ADR-0009 / T05，分支 A）。
 *
 * 职责（在 T02/T03 原生发现插件 + T04 原生信令通道之上的一层编排）：
 * - 生命周期：start = 订阅事件 → startSignalingServer（PORT_IN_USE 依次试端口）
 *   → startBrowsing → last-seen TTL 兜底轮询；stop = 反注册 + 停服务器/浏览
 * - 设备注册表：deviceFound/deviceLost 维护（DeviceRegistry），mDNS 消失延迟由
 *   pruneStale 兜底（与 Spike 页同一策略）
 * - 信令通道：connectTo（native connect，幂等）/ disconnect；peerConnected 时记录
 *   活跃通道（peerId → session，配对状态键，T04 设计定稿：瞬态事件以最终 session 为键幂等处理）
 * - 事件透传：peerConnected / peerDisconnected / messageReceived（转 SignalPayload，
 *   与 WS/QR 同构，SPEC §5.1）/ signalingError（映射为 onError）
 *
 * WebRTC 接线（T05 重点）不在本模块：Home 收到 onPeerConnected(role=initiator) 后
 * 用 ConnectionManager 建 offer 并经原生通道发出（signal 走 sendMessage）；
 * role=receiver 则等 onSignal(offer) → handleOffer 回 answer。传输/续传/OPFS 零改动。
 *
 * transport 可注入（单测用假插件；生产 = LanDiscovery facade）。
 * 纯 JS、无 @capacitor 依赖（类型来自 lan-discovery 插件，运行时不 import）。
 */
import type {
  ChannelMessageEvent,
  ConnectOptions,
  DeviceInfo,
  LanDevice,
  PeerConnectedEvent,
  SignalKind,
  SignalingErrorEvent,
  StartResult,
  StartSignalingResult,
  TrackedDevice,
} from 'lan-discovery'
import {
  CHANNEL_ERRORS,
  DEFAULT_SIGNALING_PORT,
  PERMISSION_DENIED_MARKER,
} from 'lan-discovery'
import { DeviceRegistry } from 'lan-discovery'
import type { SignalPayload } from '../protocol/signaling'

/** 默认尝试端口（SPEC §5.5：默认 8443，PORT_IN_USE 依次试 8444/8445） */
export const LAN_PORTS = [DEFAULT_SIGNALING_PORT, DEFAULT_SIGNALING_PORT + 1, DEFAULT_SIGNALING_PORT + 2]

/** mDNS last-seen TTL 兜底（默认 120s，同 Spike 页） */
export const LAN_PRUNE_TTL_MS = 120_000
/** last-seen 轮询间隔 */
export const LAN_PRUNE_INTERVAL_MS = 30_000

/**
 * 会话内部错误码（不跨原生边界；出现在 describeLanError 的未知码回退分支）：
 * - BROWSING_FAILED / SERVER_START_FAILED：原生返回 {ok:false} 但 error 缺失时的标记
 * - PERMISSION_DENIED_MARKER（= 'LOCAL_NETWORK_DENIED'）：与原生侧一致的权限拒绝标记
 */
export const LAN_SESSION_ERRORS = {
  BROWSING_FAILED: 'BROWSING_FAILED',
  SERVER_START_FAILED: 'SERVER_START_FAILED',
} as const

// ---------------------------------------------------------------------------
// 传输抽象（可注入：生产 = LanDiscovery facade；单测 = 假插件）
// ---------------------------------------------------------------------------

export type LanEventName =
  | 'deviceFound'
  | 'deviceLost'
  | 'permissionDenied'
  | 'peerConnected'
  | 'peerDisconnected'
  | 'messageReceived'
  | 'signalingError'

export type LanEventData =
  | LanDevice
  | { id: string }
  | Record<string, never>
  | PeerConnectedEvent
  | ChannelMessageEvent
  | SignalingErrorEvent

/** LanDiscovery 插件的最小视图（session 只用到这些） */
export interface LanTransport {
  startSignalingServer(options: { device: DeviceInfo }): Promise<StartSignalingResult>
  stopSignalingServer(): Promise<{ ok: boolean }>
  startBrowsing(): Promise<StartResult>
  stopBrowsing(): Promise<{ ok: boolean }>
  connect(options: ConnectOptions): Promise<{ ok: boolean; error?: string }>
  disconnect(options: { peerId: string }): Promise<{ ok: boolean }>
  sendMessage(options: { peerId: string; kind: SignalKind; sdp: string }): Promise<{ ok: boolean; error?: string }>
  addListener(eventName: LanEventName, listener: (e: LanEventData) => void): Promise<{ remove(): void }>
}

// ---------------------------------------------------------------------------
// 会话对外事件（Home / T06 UI 订阅）
// ---------------------------------------------------------------------------

export interface LanSessionEvents {
  /** 设备列表变化（发现/消失/超时清理） */
  onDevicesChanged(devices: TrackedDevice[]): void
  /** 原生信令通道建立（role = 幸存连接角色；initiator = offer 方） */
  onPeerConnected(e: PeerConnectedEvent): void
  /** 原生信令通道断开（WebRTC 数据面可能仍存活，UI 自行判断） */
  onPeerDisconnected(id: string): void
  /** 原生通道收到 offer/answer（sdp 与 WS/QR 同构，SPEC §5.1） */
  onSignal(from: string, payload: SignalPayload): void
  /** 信令服务器监听端口变化（null = 未监听） */
  onServerChange(port: number | null): void
  /** 本地网络权限被拒（需引导去设置重开） */
  onPermissionDenied(): void
  /** 通道/服务器错误（code 为 CHANNEL_ERRORS 词汇或 'LOCAL_NETWORK_DENIED'） */
  onError(code: string, message: string): void
}

export interface LanSessionOptions {
  transport: LanTransport
  /** 本机身份（广告 TXT + connect myId；port 会被 LAN_PORTS 依次覆盖） */
  device: DeviceInfo
  events: LanSessionEvents
  /** PORT_IN_USE 依次尝试的端口（默认 LAN_PORTS） */
  ports?: number[]
  /** last-seen TTL 兜底（默认 120s） */
  pruneTtlMs?: number
  /** 轮询间隔（默认 30s） */
  pruneIntervalMs?: number
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export class LanDiscoverySession {
  private readonly transport: LanTransport
  private readonly device: DeviceInfo
  private readonly events: LanSessionEvents
  private readonly ports: number[]
  private readonly pruneTtlMs: number
  private readonly pruneIntervalMs: number

  private readonly registry = new DeviceRegistry()
  private listenerRemovers: Array<{ remove(): void }> = []
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private _running = false
  private _port: number | null = null
  /** peerId → 活跃信令通道（session = 配对状态键；断线/主动断开即移除） */
  private readonly activeChannels = new Map<string, PeerConnectedEvent>()

  constructor(options: LanSessionOptions) {
    this.transport = options.transport
    this.device = options.device
    this.events = options.events
    this.ports = options.ports ?? LAN_PORTS
    this.pruneTtlMs = options.pruneTtlMs ?? LAN_PRUNE_TTL_MS
    this.pruneIntervalMs = options.pruneIntervalMs ?? LAN_PRUNE_INTERVAL_MS
  }

  get running(): boolean {
    return this._running
  }

  /** 信令服务器监听端口（null = 未监听） */
  get port(): number | null {
    return this._port
  }

  /** 发现的设备列表（插入序，含 lastSeen） */
  devices(): TrackedDevice[] {
    return this.registry.list()
  }

  /** 该对端是否有活跃原生信令通道 */
  isConnected(peerId: string): boolean {
    return this.activeChannels.has(peerId)
  }

  /** 活跃通道的配对 session（JS 侧配对状态键；无通道返回 undefined） */
  sessionOf(peerId: string): string | undefined {
    return this.activeChannels.get(peerId)?.session
  }

  /**
   * 启动会话：订阅事件 → 起信令服务器（端口占用依次尝试）→ 开始浏览 → 起 TTL 轮询。
   * 任一失败即回滚（反注册 + 停服务器）并返回 {ok:false, error}。
   */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this._running) return { ok: true }
    await this.subscribe()
    const server = await this.startServer()
    if (!server.ok) {
      await this.unsubscribe()
      return server
    }
    const browse = await this.transport.startBrowsing()
    if (!browse.ok) {
      await this.stopServer()
      await this.unsubscribe()
      // 权限拒绝：置标记（权限恢复后 getStatus 清标记）；浏览失败也向 UI 报错
      const code = browse.permissionDenied ? PERMISSION_DENIED_MARKER : LAN_SESSION_ERRORS.BROWSING_FAILED
      this.events.onError(code, browse.error ?? '开始浏览失败')
      if (browse.permissionDenied) this.events.onPermissionDenied()
      return { ok: false, error: code }
    }
    this._running = true
    this.pruneTimer = setInterval(() => {
      const removed = this.registry.pruneStale(this.pruneTtlMs, Date.now())
      if (removed.length > 0) this.events.onDevicesChanged(this.devices())
    }, this.pruneIntervalMs)
    return { ok: true }
  }

  /** 停止会话：反注册事件 + 停服务器/浏览 + 清状态（幂等） */
  async stop(): Promise<void> {
    this._running = false
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    await Promise.all([this.stopServer(), this.transport.stopBrowsing().catch(() => undefined)])
    await this.unsubscribe()
    this.registryClear()
  }

  /**
   * 主动连对端信令端口（native connect，hello 由原生发）。返回 connect 结果；
   * 通道真正可用以 onPeerConnected 为准（connect resolve 时 peerConnected 可能先到）。
   * 已连接 → {ok:true} 幂等；正在拨号中的竞态由原生消解（低 deviceId 胜）。
   */
  async connectTo(device: TrackedDevice): Promise<{ ok: boolean; error?: string }> {
    if (this.activeChannels.has(device.id)) return { ok: true }
    return this.transport.connect({ peer: device, myId: this.device.id })
  }

  /** 主动断开对端（原生会广播 peerDisconnected；此处同时清本地状态，幂等） */
  async disconnect(peerId: string): Promise<void> {
    this.activeChannels.delete(peerId)
    await this.transport.disconnect({ peerId }).catch(() => undefined)
  }

  /** 经活跃通道发 signal（offer/answer；无通道 → {ok:false, error:'NOT_CONNECTED'}） */
  async sendSignal(peerId: string, payload: SignalPayload): Promise<{ ok: boolean; error?: string }> {
    if (!this.activeChannels.has(peerId)) {
      return { ok: false, error: CHANNEL_ERRORS.NOT_CONNECTED }
    }
    return this.transport.sendMessage({ peerId, kind: payload.kind, sdp: payload.sdp })
  }

  // -------------------------------------------------------------------------
  // 事件订阅（T04 事件名见插件 index.ts；转发为会话事件）
  // -------------------------------------------------------------------------

  private async subscribe(): Promise<void> {
    const t = this.transport
    this.listenerRemovers = await Promise.all([
      t.addListener('deviceFound', (e) => {
        const d = e as LanDevice
        this.registry.add(d, Date.now())
        this.events.onDevicesChanged(this.devices())
      }),
      t.addListener('deviceLost', (e) => {
        this.registry.remove((e as { id: string }).id)
        this.events.onDevicesChanged(this.devices())
      }),
      t.addListener('permissionDenied', () => this.events.onPermissionDenied()),
      t.addListener('peerConnected', (e) => {
        const ev = e as PeerConnectedEvent
        this.activeChannels.set(ev.id, ev)
        this.events.onPeerConnected(ev)
      }),
      t.addListener('peerDisconnected', (e) => {
        const id = (e as { id: string }).id
        this.activeChannels.delete(id)
        this.events.onPeerDisconnected(id)
      }),
      t.addListener('messageReceived', (e) => {
        const m = e as ChannelMessageEvent
        // kind/sdp 与 SPEC §5.1 signal.payload 同构（sdp 已压缩，原生透明）
        this.events.onSignal(m.from, { kind: m.kind, sdp: m.sdp })
      }),
      t.addListener('signalingError', (e) => {
        const err = e as SignalingErrorEvent
        this.events.onError(err.code, err.message)
      }),
    ])
  }

  private async unsubscribe(): Promise<void> {
    const removers = this.listenerRemovers
    this.listenerRemovers = []
    for (const r of removers) {
      try {
        r.remove()
      } catch {
        /* 尽力而为 */
      }
    }
  }

  /** 起信令服务器：PORT_IN_USE 依次试端口；其余错误直接失败（附 onError） */
  private async startServer(): Promise<{ ok: boolean; error?: string }> {
    let lastError = CHANNEL_ERRORS.PORT_IN_USE
    for (const port of this.ports) {
      const r = await this.transport.startSignalingServer({ device: { ...this.device, port } })
      if (r.ok) {
        this._port = r.port ?? port
        this.events.onServerChange(this._port)
        return { ok: true }
      }
      if (r.error === PERMISSION_DENIED_MARKER) {
        this.events.onPermissionDenied()
        this.events.onError(r.error, '本地网络权限被拒，无法启动信令服务器')
        return { ok: false, error: r.error }
      }
      if (r.error !== CHANNEL_ERRORS.PORT_IN_USE) {
        this.events.onError(r.error ?? LAN_SESSION_ERRORS.SERVER_START_FAILED, `信令服务器启动失败：${r.error}`)
        return { ok: false, error: r.error }
      }
      lastError = r.error ?? lastError
    }
    this.events.onError(CHANNEL_ERRORS.PORT_IN_USE, `端口 ${this.ports.join('/')} 均被占用`)
    return { ok: false, error: lastError }
  }

  private async stopServer(): Promise<void> {
    // 即使尚未成功绑定也调原生停（原生幂等），避免残留 listener
    await this.transport.stopSignalingServer().catch(() => undefined)
    this._port = null
    this.events.onServerChange(null)
  }

  private registryClear(): void {
    for (const id of this.registry.list().map((d) => d.id)) {
      this.registry.remove(id)
    }
    this.activeChannels.clear()
    this.events.onDevicesChanged(this.devices())
  }
}

// ---------------------------------------------------------------------------
// 错误码 → 用户可读文案（T05 UI 与单测共用）
// ---------------------------------------------------------------------------

/** 错误码 → 用户可读提示；未知码退回原生 message（原生已是中文） */
export function describeLanError(code: string, message?: string): string {
  switch (code) {
    case 'LOCAL_NETWORK_DENIED':
      return '本地网络权限被拒：请到 系统设置 → 隐私与安全性 → 本地网络 开启 LocalTransfer'
    case CHANNEL_ERRORS.PORT_IN_USE:
      return `信令端口被占用，无法监听（已依次尝试 ${LAN_PORTS.join('/')}）`
    case CHANNEL_ERRORS.CONNECTION_REFUSED:
      return '连接被对方拒绝（对方可能未在首页/未开启局域网发现，或已离开）'
    case CHANNEL_ERRORS.CONNECTION_TIMEOUT:
      return '连接超时（10s 未建立信令通道，请确认对方在线后重试）'
    case CHANNEL_ERRORS.HOST_UNKNOWN:
      return '对端地址不可用（Android 端点缺 host）'
    case CHANNEL_ERRORS.ALREADY_CONNECTING:
      return '正在连接中，请稍候…'
    case CHANNEL_ERRORS.NOT_CONNECTED:
      return '信令通道未连接'
    case CHANNEL_ERRORS.PROTOCOL_VIOLATION:
      return '信令协议错误，连接已关闭'
    case CHANNEL_ERRORS.PEER_MISMATCH:
      return '对端身份不匹配，连接已拒绝'
    default:
      return message || `局域网信令错误（${code}）`
  }
}
