/**
 * LocalServerSession —— app 本地 WSS 信令服务器会话（T07 电脑端 A，ADR-0009 决策 4）。
 *
 * 职责（在 cert.ts + 原生桥之上的一层编排）：
 * - CA 生成/持久化：首次启动 WebCrypto 生成，`lt.localCa*`（localStorage）持久化
 *   —— CA 不变 → 桌面浏览器只信任一次（桌面一次性信任脚本按 SHA-256 指纹校验）
 * - 叶证书按当前地址自动重签：SAN = `DNS:<deviceId>.local` + 当前接口 IP + 127.0.0.1
 *   —— DHCP 换 IP：macOS 走 `.local` 零操作；IP 路径重输地址；永不需要重信任
 * - 网络变更自愈：地址轮询（默认 30s）检测到接口 IP 变化 → 自动重签并重启服务器
 *   （叶证书 SAN 永远覆盖当前 IP；旧 IP 地址重输即可，T08）
 * - 启动：getLocalAddresses → 证书 → startLocalServer（9443，被占依次试 9444/9445）
 * - 中继：桌面信令（wire 格式 {v:1,type:'signal',kind,sdp}，与原生通道同构，SPEC §5.1/§5.6）
 *   解析为 SignalPayload 交给调用方；sendSignal 发回桌面
 * - 地址展示：`wss://<ip>:<port>/ws?device=<deviceId>`（app 界面复制/二维码用，T08 桌面连入）
 *
 * transport 可注入（单测用假插件；生产 = LanDiscovery facade）。
 * 与 lanSession.ts 同一依赖纪律：类型来自 lan-discovery 插件，运行时不直接 import @capacitor。
 */
import type { DeviceInfo, LocalServerOptions, LocalServerResult } from 'lan-discovery'
import { LOCAL_SERVER_PORTS, LOCAL_SERVER_ERRORS } from 'lan-discovery'
import type { SignalPayload } from '../protocol/signaling'
import {
  createSigningAuthority,
  fingerprintSha256,
  isUsableCa,
  localHostName,
  signLeafCertificate,
  type SigningAuthority,
} from './cert'

/** CA 持久化键（localStorage；CA 密钥仅 app 内，对应 ADR-0009 决策 4 的权衡） */
export const LOCAL_CA_KEY = 'lt.localCa'
export const LOCAL_CA_KEY_PEM = 'lt.localCaKey'

/** 叶证书 SAN 恒含回环（本机调试/桌面同机场景） */
export const LOCAL_LOOPBACK_IP = '127.0.0.1'

/** 本地服务器错误码（沿用原生词汇；会话层兜底码） */
export const LOCAL_SESSION_ERRORS = {
  SERVER_START_FAILED: 'SERVER_START_FAILED',
  CERT_FAILED: 'CERT_FAILED',
  ADDRESS_FAILED: 'ADDRESS_FAILED',
} as const

export interface LocalServerStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** LanDiscovery 插件的最小视图（session 只用到这些） */
export interface LocalServerTransport {
  startLocalServer(options: LocalServerOptions): Promise<LocalServerResult>
  stopLocalServer(): Promise<{ ok: boolean }>
  sendLocalMessage(options: { message: string }): Promise<{ ok: boolean; error?: string }>
  getLocalAddresses(): Promise<{ addresses: string[] }>
  addListener(
    eventName: 'localClientConnected' | 'localClientDisconnected' | 'localMessageReceived' | 'localServerError',
    listener: (e: Record<string, never> | { message: string } | { code: string; message: string }) => void,
  ): Promise<{ remove(): void }>
}

export interface LocalServerEvents {
  /** 桌面客户端连接状态变化 */
  onClientChange(connected: boolean): void
  /** 桌面发来的信令（SignalPayload，与 WS/QR 同构） */
  onSignal(payload: SignalPayload): void
  /** 错误（码 = LOCAL_SERVER_ERRORS 词汇或 LOCAL_SESSION_ERRORS 兜底） */
  onError(code: string, message: string): void
}

export interface LocalServerSessionOptions {
  transport: LocalServerTransport
  /** 本机身份（deviceId 用于 .local 名 + /ws?device= 校验；name/kind 供服务器信息页） */
  device: DeviceInfo
  events: LocalServerEvents
  /** 依次尝试的端口（默认 LOCAL_SERVER_PORTS：9443/9444/9445，与 app↔app 8443 分离） */
  ports?: number[]
  /** CA 持久化（默认 localStorage；测试注入假存储） */
  storage?: LocalServerStorage
  /** 证书相关纯函数可注入（测试用） */
  certImpl?: typeof certModule
  /** 地址变化轮询间隔（默认 30s；网络变更自动重签用；0 = 关闭轮询） */
  addressPollMs?: number
}

// 默认证书实现（运行时可整体替换测试）
const certModule = { createSigningAuthority, signLeafCertificate, fingerprintSha256, isUsableCa }

/** 默认地址轮询间隔（网络变更自动重签；与 LAN 发现的 last-seen 轮询同级） */
export const LOCAL_ADDRESS_POLL_MS = 30_000

/** 桌面连入地址（UI 展示/复制；T08 Chrome 端连这个） */
export function localServerUrl(address: string, port: number, deviceId: string): string {
  return `wss://${address}:${port}/ws?device=${deviceId}`
}

/** 桌面信令 wire 消息（与原生通道 signal 帧同构；sdp 与 WS/QR 同压缩约定） */
export function makeLocalSignalMessage(payload: SignalPayload): string {
  return JSON.stringify({ v: 1, type: 'signal', kind: payload.kind, sdp: payload.sdp })
}

/** 解析桌面 wire 消息为 SignalPayload；非法返回 null（丢弃） */
export function parseLocalSignalMessage(message: string): SignalPayload | null {
  try {
    const json = JSON.parse(message) as Record<string, unknown>
    if (json.v !== 1 || json.type !== 'signal') return null
    const kind = json.kind
    const sdp = json.sdp
    if (kind !== 'offer' && kind !== 'answer') return null
    if (typeof sdp !== 'string' || sdp.trim() === '') return null
    return { kind, sdp }
  } catch {
    return null
  }
}

export class LocalServerSession {
  private readonly transport: LocalServerTransport
  private readonly device: DeviceInfo
  private readonly events: LocalServerEvents
  private readonly ports: number[]
  private readonly storage: LocalServerStorage
  private readonly cert: typeof certModule

  private listenerRemovers: Array<{ remove(): void }> = []
  private _running = false
  private _port: number | null = null
  private _addresses: string[] = []
  private _clientConnected = false
  private _caPem: string | null = null
  private _caFingerprint: string | null = null
  /** 上次启动/重签时的地址集（地址轮询变化检测用） */
  private currentAddresses: string[] = []
  private addressTimer: ReturnType<typeof setInterval> | null = null
  /** 网络变更重签进行中标记（防止重入） */
  private resigning = false
  private readonly addressPollMs: number

  constructor(options: LocalServerSessionOptions) {
    this.transport = options.transport
    this.device = options.device
    this.events = options.events
    this.ports = options.ports ?? LOCAL_SERVER_PORTS
    this.storage = options.storage ?? defaultStorage()
    this.cert = options.certImpl ?? certModule
    this.addressPollMs = options.addressPollMs ?? LOCAL_ADDRESS_POLL_MS
  }

  get running(): boolean {
    return this._running
  }

  /** 实际监听端口（null = 未监听） */
  get port(): number | null {
    return this._port
  }

  /** 当前接口局域网地址（启动时刷新；空 = 无可用地址） */
  get addresses(): string[] {
    return [...this._addresses]
  }

  /** 桌面客户端是否已连接 */
  get clientConnected(): boolean {
    return this._clientConnected
  }

  /** CA 证书 PEM（UI 展示/桌面脚本指纹比对用） */
  get caPem(): string | null {
    return this._caPem
  }

  /** CA SHA-256 指纹（冒号分隔大写；桌面一次性信任脚本校验用） */
  get caFingerprint(): string | null {
    return this._caFingerprint
  }

  /** 桌面连入完整地址列表（每个接口地址一条；UI 复制/二维码用） */
  urls(): string[] {
    if (this._port === null) return []
    return this._addresses.map((a) => localServerUrl(a, this._port!, this.device.id))
  }

  /**
   * 启动：订阅事件 → 取地址 → 证书（CA 持久化 + 按当前地址重签叶证书）→ 起服务器
   * → 地址变化轮询（网络变更自动重签）。任一失败回滚并返回 {ok:false, error}（事件已通知）。
   */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this._running) return { ok: true }
    await this.subscribe()

    const addresses = await this.fetchAddresses()
    if (addresses.length === 0) {
      await this.unsubscribe()
      const code = LOCAL_SESSION_ERRORS.ADDRESS_FAILED
      this.events.onError(code, '无法获取本机局域网地址（检查 Wi-Fi 连接）')
      return { ok: false, error: code }
    }

    const certResult = await this.makeLeafCertificate(addresses)
    if (!certResult.ok) {
      await this.unsubscribe()
      return certResult
    }

    const started = await this.startServer(certResult.caPem!, certResult.certPem!, certResult.keyPem!)
    if (!started.ok) {
      await this.unsubscribe()
      return started
    }
    this._running = true
    this.currentAddresses = addresses
    this.startAddressPoll()
    return { ok: true }
  }

  /** 停止：反注册事件 + 停服务器 + 停轮询（幂等） */
  async stop(): Promise<void> {
    this._running = false
    this.stopAddressPoll()
    this._port = null
    this._addresses = []
    this._clientConnected = false
    this.currentAddresses = []
    await this.transport.stopLocalServer().catch(() => undefined)
    await this.unsubscribe()
  }

  /** 向桌面客户端发信令（无客户端 → {ok:false, error:'NO_CLIENT'}） */
  async sendSignal(payload: SignalPayload): Promise<{ ok: boolean; error?: string }> {
    if (!this._clientConnected) {
      return { ok: false, error: LOCAL_SERVER_ERRORS.NO_CLIENT }
    }
    return this.transport.sendLocalMessage({ message: makeLocalSignalMessage(payload) })
  }

  // -------------------------------------------------------------------------

  /** 取当前局域网地址（回环/link-local 过滤）；失败返回 [] */
  private async fetchAddresses(): Promise<string[]> {
    try {
      const r = await this.transport.getLocalAddresses()
      return r.addresses.filter(isLanAddress)
    } catch {
      return []
    }
  }

  /**
   * 生成/载入 CA + 按当前地址重签叶证书。CA 损坏（DER/密钥非法）→ 自愈：重新生成。
   * 叶证书失败且 CA 来自持久化 → 清库重生成 CA 重试一次（双保险）。
   */
  private async makeLeafCertificate(addresses: string[]): Promise<{
    ok: boolean
    caPem?: string
    certPem?: string
    keyPem?: string
    error?: string
  }> {
    const tryOnce = async (): Promise<{ ca: SigningAuthority; fromStorage: boolean } | null> => {
      const stored = this.storage.getItem(LOCAL_CA_KEY)
      const storedKey = this.storage.getItem(LOCAL_CA_KEY_PEM)
      if (
        stored &&
        storedKey &&
        stored.includes('BEGIN CERTIFICATE') &&
        storedKey.includes('BEGIN PRIVATE KEY') &&
        (await this.cert.isUsableCa(stored, storedKey))
      ) {
        this._caPem = stored
        this._caFingerprint = await this.cert.fingerprintSha256(stored)
        return { ca: { caPem: stored, caKeyPem: storedKey }, fromStorage: true }
      }
      // 缺失 / 损坏 → 重新生成并持久化（CA 不变 → 桌面只信任一次；重生成意味着需重新信任一次）
      const ca = await this.cert.createSigningAuthority(`LocalTransfer CA (${this.device.name})`)
      this.storage.setItem(LOCAL_CA_KEY, ca.caPem)
      this.storage.setItem(LOCAL_CA_KEY_PEM, ca.caKeyPem)
      this._caPem = ca.caPem
      this._caFingerprint = await this.cert.fingerprintSha256(ca.caPem)
      return { ca, fromStorage: false }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const loaded = await tryOnce()
        if (loaded === null) throw new Error('CA 生成失败')
        const leaf = await this.cert.signLeafCertificate({
          caPem: loaded.ca.caPem,
          caKeyPem: loaded.ca.caKeyPem,
          dnsName: localHostName(this.device.id),
          ipAddresses: [...addresses, LOCAL_LOOPBACK_IP],
          commonName: this.device.name,
        })
        return { ok: true, caPem: loaded.ca.caPem, certPem: leaf.certPem, keyPem: leaf.keyPem }
      } catch (e) {
        // 第一次失败（可能是持久化 CA 的密钥损坏）：清库重生成重试一次；仍失败 → CERT_FAILED
        if (attempt === 0 && this.storage.getItem(LOCAL_CA_KEY)) {
          this.storage.removeItem(LOCAL_CA_KEY)
          this.storage.removeItem(LOCAL_CA_KEY_PEM)
          continue
        }
        const detail = e instanceof Error ? e.message : String(e)
        this.events.onError(LOCAL_SESSION_ERRORS.CERT_FAILED, `证书生成失败：${detail}`)
        return { ok: false, error: LOCAL_SESSION_ERRORS.CERT_FAILED }
      }
    }
    return { ok: false, error: LOCAL_SESSION_ERRORS.CERT_FAILED }
  }

  /** 地址轮询：接口 IP 变化 → 自动重签并重启服务器（叶证书 SAN 覆盖新 IP） */
  private startAddressPoll(): void {
    if (this.addressPollMs <= 0) return
    this.stopAddressPoll()
    this.addressTimer = setInterval(() => {
      void this.pollAddresses()
    }, this.addressPollMs)
  }

  private stopAddressPoll(): void {
    if (this.addressTimer !== null) {
      clearInterval(this.addressTimer)
      this.addressTimer = null
    }
  }

  private async pollAddresses(): Promise<void> {
    if (!this._running || this.resigning) return
    const addresses = await this.fetchAddresses()
    if (addresses.length === 0) return // 网络瞬断：保留现状（客户端可短暂掉线重连）
    const changed =
      addresses.length !== this.currentAddresses.length ||
      addresses.some((a, i) => a !== this.currentAddresses[i])
    if (!changed) return
    this.resigning = true
    try {
      await this.transport.stopLocalServer().catch(() => undefined)
      this._clientConnected = false
      this.events.onClientChange(false)
      const certResult = await this.makeLeafCertificate(addresses)
      if (!certResult.ok) {
        this.events.onError(LOCAL_SESSION_ERRORS.CERT_FAILED, '网络变更后重签证书失败')
        this._running = false
        this.stopAddressPoll()
        return
      }
      const started = await this.startServer(certResult.caPem!, certResult.certPem!, certResult.keyPem!)
      if (!started.ok) {
        this._running = false
        this.stopAddressPoll()
        return
      }
      this.currentAddresses = addresses
      this.events.onClientChange(false)
    } finally {
      this.resigning = false
    }
  }

  /** 起服务器：端口被占依次试；权限拒绝/其他错误直接失败 */
  private async startServer(
    caPem: string,
    certPem: string,
    keyPem: string,
  ): Promise<{ ok: boolean; error?: string }> {
    let lastError = LOCAL_SERVER_ERRORS.PORT_IN_USE
    for (const port of this.ports) {
      const r = await this.transport.startLocalServer({
        certPem,
        keyPem,
        caPem,
        device: { ...this.device, port },
      })
      if (r.ok) {
        this._port = r.port ?? port
        this._addresses = r.addresses?.filter(isLanAddress) ?? this._addresses
        return { ok: true }
      }
      if (r.error === LOCAL_SERVER_ERRORS.LOCAL_NETWORK_DENIED) {
        this.events.onError(r.error, '本地网络权限被拒，无法启动本地服务器（设置 → 隐私与安全性 → 本地网络）')
        return { ok: false, error: r.error }
      }
      if (r.error !== LOCAL_SERVER_ERRORS.PORT_IN_USE) {
        this.events.onError(r.error ?? LOCAL_SESSION_ERRORS.SERVER_START_FAILED, `本地服务器启动失败：${r.error}`)
        return { ok: false, error: r.error }
      }
      lastError = r.error ?? lastError
    }
    this.events.onError(LOCAL_SERVER_ERRORS.PORT_IN_USE, `端口 ${this.ports.join('/')} 均被占用`)
    return { ok: false, error: lastError }
  }

  private async subscribe(): Promise<void> {
    const t = this.transport
    this.listenerRemovers = await Promise.all([
      t.addListener('localClientConnected', () => {
        this._clientConnected = true
        this.events.onClientChange(true)
      }),
      t.addListener('localClientDisconnected', () => {
        this._clientConnected = false
        this.events.onClientChange(false)
      }),
      t.addListener('localMessageReceived', (e) => {
        const text = (e as { message: string }).message
        const payload = parseLocalSignalMessage(text)
        if (payload) this.events.onSignal(payload)
      }),
      t.addListener('localServerError', (e) => {
        const err = e as { code: string; message: string }
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
}

/** 局域网地址过滤：IPv4 非回环、非 link-local（SAN/展示用） */
function isLanAddress(ip: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1' && !ip.startsWith('169.254.')
}

/** 浏览器默认存储（localStorage 形状；localClient 复用——T08 评审去重） */
export function defaultStorage(): LocalServerStorage {
  return {
    getItem: (k) => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null),
    setItem: (k, v) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem(k, v)
    },
    removeItem: (k) => {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(k)
    },
  }
}