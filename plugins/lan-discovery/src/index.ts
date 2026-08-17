/**
 * lan-discovery —— ADR-0009 局域网发现插件的类型化 facade（T02 iOS / T03 Android）。
 *
 * 桥模式对齐 plugins/folder-export：本地插件经 SPM 链接（cap sync 自动注册），
 * JS 侧 Capacitor.registerPlugin + 类型化接口；web 构建（非壳）下所有调用明确拒绝
 * （浏览器无 mDNS/DNS-SD 能力，ADR-0009 决策 1）。
 *
 * 原语：startAdvertising / stopAdvertising / startBrowsing / stopBrowsing / getStatus；
 * 事件：deviceFound（发现或变化）/ deviceLost（消失）/ permissionDenied（本地网络权限被拒）。
 * TXT schema（RFC 6763）见 txt.ts；设备列表 last-seen 维护见 registry.ts。
 *
 * facade 用 Proxy 包装 registerPlugin 的返回值：startAdvertising 先做 JS 侧参数校验
 * （非法参数先于原生被拦，LanOptionsError），其余原语/事件原样委托。
 */
import { registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { validateAdvertisingOptions, LanOptionsError } from './txt'
import type { DeviceInfo } from './txt'
import type { LanDevice } from './registry'
import { validateConnectOptions, validateSignalPayload } from './channel'
import type { ChannelErrorCode, ConnectOptions, SignalKind } from './channel'

export {
  LAN_KINDS,
  LanOptionsError,
  SERVICE_TYPE,
  TXT_VALUE_MAX_BYTES,
  byteLengthUtf8,
  validateAdvertisingOptions,
} from './txt'
export type { DeviceInfo, DeviceKind } from './txt'
export { DeviceRegistry } from './registry'
export type { LanDevice, TrackedDevice } from './registry'
export {
  CHANNEL_ERRORS,
  CONNECT_TIMEOUT_MS,
  DEFAULT_SIGNALING_PORT,
  FRAME_LENGTH_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
} from './channel'
export type {
  ChannelErrorCode,
  ChannelMessage,
  ConflictDecision,
  ConnectOptions,
  SignalKind,
} from './channel'

/** 事件名常量（T06 UI 订阅用） */
export const LAN_DISCOVERY_EVENTS = {
  deviceFound: 'deviceFound',
  deviceLost: 'deviceLost',
  permissionDenied: 'permissionDenied',
} as const

/** 原生信令通道事件名常量（T04/T05 订阅用；见 channel.ts 协议说明） */
export const LAN_CHANNEL_EVENTS = {
  peerConnected: 'peerConnected',
  peerDisconnected: 'peerDisconnected',
  messageReceived: 'messageReceived',
  signalingError: 'signalingError',
} as const

/** 本地 WSS 服务器事件名常量（T07 电脑腿 A 订阅用；原生只转信令） */
export const LOCAL_SERVER_EVENTS = {
  clientConnected: 'localClientConnected',
  clientDisconnected: 'localClientDisconnected',
  messageReceived: 'localMessageReceived',
  serverError: 'localServerError',
} as const

/** 本地服务器（WSS 电脑腿）事件类型 */
export interface LocalClientConnectedEvent {
  /** 桌面端点地址（IP:port，展示/日志用） */
  address?: string
}

export interface LocalMessageEvent {
  /** 桌面 Chrome 发来的原始 JSON 信令文本（JS 侧校验为 signal.payload 后使用） */
  message: string
}

/** 通道角色：幸存连接的发起方 = initiator（T05 中即 offer 方） */
export type ChannelRole = 'initiator' | 'receiver'

export interface StartResult {
  ok: boolean
  /** 失败原因（权限拒绝时 = PERMISSION_DENIED_MARKER） */
  error?: string
  /** 本地网络权限被拒（拒绝后功能不可用，需引导去设置重开） */
  permissionDenied?: boolean
}

export interface LanDiscoveryStatus {
  advertising: boolean
  browsing: boolean
  permissionDenied: boolean
  /** T04：信令服务器是否在监听（SRV/TXT 端口一致，SPEC §5.5） */
  signaling: boolean
  /** T07：本地 WSS 服务器（电脑腿）是否在监听 */
  localServer: boolean
}

/** 权限被拒的机器可识别标记（与原生侧一致） */
export const PERMISSION_DENIED_MARKER = 'LOCAL_NETWORK_DENIED'

// ---------------------------------------------------------------------------
// 本地 WSS 服务器（T07 电脑腿 A，ADR-0009 决策 4）API 形状
// ---------------------------------------------------------------------------

/**
 * 启动本地 WSS 服务器（只转信令）：桌面 Chrome 主动连入的宿主。
 * 证书由 JS 侧生成（cert.ts：CA + 叶证书，SAN 已覆盖 .local + 当前 IP），
 * 原生只管 PEM → TLS 监听 + WebSocket 握手/帧 + 信令中继。
 */
export interface LocalServerOptions {
  /** 叶证书 PEM（SAN = DNS:<deviceId>.local + 当前 IP + 127.0.0.1） */
  certPem: string
  /** 叶私钥 PEM（PKCS#8） */
  keyPem: string
  /** CA 证书 PEM（/ca.crt 端点供桌面一次性信任脚本下载） */
  caPem: string
  /** 本机设备信息（deviceId 校验 /ws?device=；name/kind 供 / 信息页） */
  device: DeviceInfo
}

/**
 * WSS 默认端口（SPEC §5.6）：与 app↔app TCP 信令端口（8443）分离，
 * 避免双监听冲突（T07 备注「WSS 端口冲突/占用处理」）：9443 起，被占依次试 9444/9445。
 */
export const DEFAULT_LOCAL_SERVER_PORT = 9443
/** 依次尝试的端口池 */
export const LOCAL_SERVER_PORTS = [DEFAULT_LOCAL_SERVER_PORT, 9444, 9445]

export interface LocalServerResult {
  ok: boolean
  /** 实际监听端口（默认 9443；被占依次试 9444/9445） */
  port?: number
  /** 当前各接口局域网地址（IP，桌面连入用；随监听启动刷新） */
  addresses?: string[]
  /** 失败原因（PORT_IN_USE / LOCAL_NETWORK_DENIED 等） */
  error?: string
}

export interface SendLocalMessageOptions {
  /** 发给桌面客户端的信令 JSON 文本（signal.payload 结构；原生透明转发） */
  message: string
}

/** 本地服务器错误码（复用通道词表；新增本地专用） */
export const LOCAL_SERVER_ERRORS = {
  PORT_IN_USE: 'PORT_IN_USE',
  LOCAL_NETWORK_DENIED: 'LOCAL_NETWORK_DENIED',
  NO_CLIENT: 'NO_CLIENT',
  INVALID_PARAMS: 'INVALID_PARAMS',
  TLS_SETUP_FAILED: 'TLS_SETUP_FAILED',
} as const
export type LocalServerErrorCode = (typeof LOCAL_SERVER_ERRORS)[keyof typeof LOCAL_SERVER_ERRORS]

/** 启动信令服务器：绑定 device.port 并挂 Bonjour（SRV 端口 = TXT 端口 = 监听端口） */
export interface StartSignalingOptions {
  device: DeviceInfo
}

export interface StartSignalingResult {
  ok: boolean
  /** 实际绑定端口（= device.port；失败时缺省） */
  port?: number
  /** 失败原因（PORT_IN_USE / 权限拒绝等） */
  error?: string
}

export interface SendMessageOptions {
  peerId: string
  kind: SignalKind
  /** gzip+base64url 的 SDP（与 WS/QR 同一压缩约定，SPEC §5.1） */
  sdp: string
}

/** peerConnected 事件载荷：双方以 session 作配对状态键（幂等处理瞬态） */
export interface PeerConnectedEvent {
  id: string
  session: string
  role: ChannelRole
}

export interface ChannelMessageEvent {
  from: string
  session: string
  kind: SignalKind
  sdp: string
}

export interface SignalingErrorEvent {
  peerId?: string
  code: ChannelErrorCode
  message: string
}

export interface LanDiscoveryPlugin {
  /** 开始广告本机设备（_localtranfer._tcp + TXT）；参数非法抛 LanOptionsError */
  startAdvertising(options: DeviceInfo): Promise<StartResult>
  stopAdvertising(): Promise<{ ok: boolean }>
  /** 开始浏览局域网设备；权限被拒时 ok:false + permissionDenied:true */
  startBrowsing(): Promise<StartResult>
  stopBrowsing(): Promise<{ ok: boolean }>
  /**
   * T07：启动本地 WSS 服务器（电脑腿 A，只转信令）。
   * 端口被占 → {ok:false, error:'PORT_IN_USE'}（JS 依次试 9444/9445）；
   * 本地网络权限被拒 → {ok:false, error:'LOCAL_NETWORK_DENIED'}。
   */
  startLocalServer(options: LocalServerOptions): Promise<LocalServerResult>
  stopLocalServer(): Promise<{ ok: boolean }>
  /**
   * T07：向桌面客户端发信令 JSON 文本（原生透明转发；无客户端 → {ok:false, error:'NO_CLIENT'}）。
   */
  sendLocalMessage(options: SendLocalMessageOptions): Promise<{ ok: boolean; error?: string }>
  /**
   * T07：当前各接口的局域网 IPv4 地址（en0/en1/wlan0 等，已滤回环/隧道；SAN 构建与 UI 展示用）。
   */
  getLocalAddresses(): Promise<{ addresses: string[] }>

  /**
   * T04：启动原生信令服务器（TCP 监听 device.port + Bonjour 广告，SRV=TXT=监听端口）。
   * 端口被占 → {ok:false, error:'PORT_IN_USE'}（JS 依次试后续端口）；参数非法抛 LanOptionsError。
   */
  startSignalingServer(options: StartSignalingOptions): Promise<StartSignalingResult>
  stopSignalingServer(): Promise<{ ok: boolean }>
  /**
   * T04：主动连对端信令端口（iOS 走 .service 端点解析 SRV；Android 走 host:port）。
   * 连上即发 hello（携带 myId + 新 session）；双发起竞态由原生消解（低 id 胜）。
   * 失败 {ok:false, error}（CONNECTION_REFUSED / CONNECTION_TIMEOUT / HOST_UNKNOWN / ALREADY_CONNECTING）。
   */
  connect(options: ConnectOptions): Promise<{ ok: boolean; error?: string }>
  disconnect(options: { peerId: string }): Promise<{ ok: boolean }>
  /**
   * T04：向 peerId 的活跃通道发 signal 帧（kind/sdp 与 SPEC §5.1 signal.payload 一致）。
   * 无活跃通道 → {ok:false, error:'NOT_CONNECTED'}；参数非法抛 LanOptionsError。
   */
  sendMessage(options: SendMessageOptions): Promise<{ ok: boolean; error?: string }>
  getStatus(): Promise<LanDiscoveryStatus>
  addListener(
    eventName: 'deviceFound',
    listenerFunc: (device: LanDevice) => void,
  ): Promise<PluginListenerHandle>
  addListener(eventName: 'deviceLost', listenerFunc: (device: { id: string }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'permissionDenied', listenerFunc: () => void): Promise<PluginListenerHandle>
  addListener(eventName: 'peerConnected', listenerFunc: (e: PeerConnectedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'peerDisconnected', listenerFunc: (e: { id: string }) => void): Promise<PluginListenerHandle>
  addListener(
    eventName: 'messageReceived',
    listenerFunc: (e: ChannelMessageEvent) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'signalingError',
    listenerFunc: (e: SignalingErrorEvent) => void,
  ): Promise<PluginListenerHandle>
  /** T07 本地 WSS 服务器事件 */
  addListener(eventName: 'localClientConnected', listenerFunc: (e: LocalClientConnectedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'localClientDisconnected', listenerFunc: () => void): Promise<PluginListenerHandle>
  addListener(eventName: 'localMessageReceived', listenerFunc: (e: LocalMessageEvent) => void): Promise<PluginListenerHandle>
  addListener(
    eventName: 'localServerError',
    listenerFunc: (e: { code: string; message: string }) => void,
  ): Promise<PluginListenerHandle>
}

const rawLanDiscovery = registerPlugin<LanDiscoveryPlugin>('LanDiscovery', {
  web: () => import('./web').then((m) => m.webLanDiscovery),
})

/** 校验 + 委托包装（见模块注释）：参数非法先于原生被拦（LanOptionsError） */
export const LanDiscovery: LanDiscoveryPlugin = new Proxy(rawLanDiscovery, {
  get(target, prop, receiver) {
    if (prop === 'startAdvertising') {
      return async (options: DeviceInfo) => {
        validateAdvertisingOptions(options)
        return target.startAdvertising(options)
      }
    }
    if (prop === 'startSignalingServer') {
      return async (options: StartSignalingOptions) => {
        try {
          validateAdvertisingOptions(options.device)
        } catch (e) {
          throw toLanOptionsError('startSignalingServer', e)
        }
        return target.startSignalingServer(options)
      }
    }
    if (prop === 'connect') {
      return async (options: ConnectOptions) => {
        try {
          validateConnectOptions(options)
        } catch (e) {
          throw toLanOptionsError('connect', e)
        }
        return target.connect(options)
      }
    }
    if (prop === 'sendMessage') {
      return async (options: SendMessageOptions) => {
        try {
          validateSignalPayload(options.kind, options.sdp)
        } catch (e) {
          throw toLanOptionsError('sendMessage', e)
        }
        return target.sendMessage(options)
      }
    }
    // T07 本地服务器（电脑腿）：证书 PEM 合法性 + 消息大小前置校验
    if (prop === 'startLocalServer') {
      return async (options: LocalServerOptions) => {
        try {
          validateLocalServerOptions(options)
        } catch (e) {
          throw toLanOptionsError('startLocalServer', e)
        }
        return target.startLocalServer(options)
      }
    }
    if (prop === 'sendLocalMessage') {
      return async (options: SendLocalMessageOptions) => {
        try {
          validateLocalMessage(options.message)
        } catch (e) {
          throw toLanOptionsError('sendLocalMessage', e)
        }
        return target.sendLocalMessage(options)
      }
    }
    return Reflect.get(target, prop, receiver)
  },
})

/** 本地服务器消息单条上限（信令 JSON 远小于此；对齐帧上限语义） */
export const LOCAL_MESSAGE_MAX_BYTES = 64 * 1024

/** startLocalServer 参数校验：PEM 块齐全 + 设备信息合法（先于原生被拦） */
export function validateLocalServerOptions(options: LocalServerOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new LanOptionsError('startLocalServer 参数必须是对象')
  }
  for (const [field, label] of [
    ['certPem', 'CERTIFICATE'],
    ['keyPem', 'PRIVATE KEY'],
    ['caPem', 'CERTIFICATE'],
  ] as const) {
    const v = (options as unknown as Record<string, unknown>)[field]
    if (typeof v !== 'string' || !hasPemBlock(v, label)) {
      throw new LanOptionsError(`certPem/keyPem/caPem 必须是合法 PEM（缺 ${label} 块）`)
    }
  }
  try {
    validateAdvertisingOptions(options.device)
  } catch (e) {
    throw new LanOptionsError(`device 非法：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** sendLocalMessage 参数校验：≤64KiB 的非空字符串 */
export function validateLocalMessage(message: unknown): asserts message is string {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new LanOptionsError('message 必须是非空字符串')
  }
  const bytes = new TextEncoder().encode(message).byteLength
  if (bytes > LOCAL_MESSAGE_MAX_BYTES) {
    throw new LanOptionsError(`message 超过 ${LOCAL_MESSAGE_MAX_BYTES} 字节上限`)
  }
}

/** 校验错误统一转 facade 的错误类型（与 startAdvertising 的 LanOptionsError 一致） */
function toLanOptionsError(method: string, e: unknown): Error {
  if (e instanceof LanOptionsError) return e
  const detail = e instanceof Error ? e.message : String(e)
  return new LanOptionsError(`${method} 参数非法：${detail}`)
}

/** PEM 块存在性检查（宽松：多块也可） */
function hasPemBlock(pem: string, label: string): boolean {
  return new RegExp(`-----BEGIN ${label}-----(?:[\\s\\S])*?-----END ${label}-----`).test(pem)
}

