/**
 * web 降级实现：浏览器无 mDNS/DNS-SD 浏览、无 UDP 组播/广播、无 TCP 监听/连接
 * （ADR-0009 决策 1 核实）。非壳（浏览器）环境调用原生发现/信令即明确报错；
 * addListener/removeAllListeners 继承 WebPlugin 的 no-op 事件机制（web 无事件可收，但不炸）。
 * app 端（Capacitor）走原生实现；T06 仅在 app 内接入本插件。
 */
import { WebPlugin } from '@capacitor/core'
import type { LanDiscoveryPlugin, LanDiscoveryStatus, StartResult, StartSignalingResult } from './index'
import type { ConnectOptions, DeviceInfo, SendMessageOptions } from './index'

const unavailable = (method: string) =>
  Promise.reject(new Error(`LanDiscovery.${method} 仅 app 内可用（ADR-0009）`))

export class WebLanDiscovery extends WebPlugin implements LanDiscoveryPlugin {
  startAdvertising(_options: DeviceInfo): Promise<StartResult> {
    return unavailable('startAdvertising')
  }

  stopAdvertising(): Promise<{ ok: boolean }> {
    return unavailable('stopAdvertising')
  }

  startBrowsing(): Promise<StartResult> {
    return unavailable('startBrowsing')
  }

  stopBrowsing(): Promise<{ ok: boolean }> {
    return unavailable('stopBrowsing')
  }

  startSignalingServer(_options: { device: DeviceInfo }): Promise<StartSignalingResult> {
    return unavailable('startSignalingServer')
  }

  stopSignalingServer(): Promise<{ ok: boolean }> {
    return unavailable('stopSignalingServer')
  }

  connect(_options: ConnectOptions): Promise<{ ok: boolean; error?: string }> {
    return unavailable('connect')
  }

  disconnect(_options: { peerId: string }): Promise<{ ok: boolean }> {
    return unavailable('disconnect')
  }

  sendMessage(_options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    return unavailable('sendMessage')
  }

  getStatus(): Promise<LanDiscoveryStatus> {
    return unavailable('getStatus')
  }
}

export const webLanDiscovery = new WebLanDiscovery()
