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
}

/** 权限被拒的机器可识别标记（与原生侧一致） */
export const PERMISSION_DENIED_MARKER = 'LOCAL_NETWORK_DENIED'

// ---------------------------------------------------------------------------
// 原生信令通道（T04）API 形状
// ---------------------------------------------------------------------------

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
    return Reflect.get(target, prop, receiver)
  },
})

/** 校验错误统一转 facade 的错误类型（与 startAdvertising 的 LanOptionsError 一致） */
function toLanOptionsError(method: string, e: unknown): Error {
  if (e instanceof LanOptionsError) return e
  const detail = e instanceof Error ? e.message : String(e)
  return new LanOptionsError(`${method} 参数非法：${detail}`)
}

