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
import { validateAdvertisingOptions } from './txt'
import type { DeviceInfo } from './txt'
import type { LanDevice } from './registry'

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

/** 事件名常量（T06 UI 订阅用） */
export const LAN_DISCOVERY_EVENTS = {
  deviceFound: 'deviceFound',
  deviceLost: 'deviceLost',
  permissionDenied: 'permissionDenied',
} as const

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
}

/** 权限被拒的机器可识别标记（与原生侧一致） */
export const PERMISSION_DENIED_MARKER = 'LOCAL_NETWORK_DENIED'

export interface LanDiscoveryPlugin {
  /** 开始广告本机设备（_localtranfer._tcp + TXT）；参数非法抛 LanOptionsError */
  startAdvertising(options: DeviceInfo): Promise<StartResult>
  stopAdvertising(): Promise<{ ok: boolean }>
  /** 开始浏览局域网设备；权限被拒时 ok:false + permissionDenied:true */
  startBrowsing(): Promise<StartResult>
  stopBrowsing(): Promise<{ ok: boolean }>
  getStatus(): Promise<LanDiscoveryStatus>
  addListener(
    eventName: 'deviceFound',
    listenerFunc: (device: LanDevice) => void,
  ): Promise<PluginListenerHandle>
  addListener(eventName: 'deviceLost', listenerFunc: (device: { id: string }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'permissionDenied', listenerFunc: () => void): Promise<PluginListenerHandle>
}

const rawLanDiscovery = registerPlugin<LanDiscoveryPlugin>('LanDiscovery', {
  web: () => import('./web').then((m) => m.webLanDiscovery),
})

/** 校验 + 委托包装（见模块注释） */
export const LanDiscovery: LanDiscoveryPlugin = new Proxy(rawLanDiscovery, {
  get(target, prop, receiver) {
    if (prop === 'startAdvertising') {
      return async (options: DeviceInfo) => {
        validateAdvertisingOptions(options)
        return target.startAdvertising(options)
      }
    }
    return Reflect.get(target, prop, receiver)
  },
})
