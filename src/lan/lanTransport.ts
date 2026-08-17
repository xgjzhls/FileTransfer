/**
 * 生产 transport：把 lan-discovery 插件 facade 适配为 LanSession 的 LanTransport。
 * 单独成文件以便 lanSession.ts 保持纯 JS（无 @capacitor 依赖，单测不 import 本文件）。
 *
 * facade（Proxy 包装）在委托原生前做参数校验（startSignalingServer/connect/sendMessage），
 * 浏览器（非壳）环境调用即明确报错（web 降级，ADR-0009）——T05 仅在 app 壳内使用。
 */
import { LanDiscovery } from 'lan-discovery'
import type { LanTransport } from './lanSession'
import type { LocalServerTransport } from './localServer'

export const lanDiscoveryTransport: LanTransport = {
  startSignalingServer: (options) => LanDiscovery.startSignalingServer(options),
  stopSignalingServer: () => LanDiscovery.stopSignalingServer(),
  startBrowsing: () => LanDiscovery.startBrowsing(),
  stopBrowsing: () => LanDiscovery.stopBrowsing(),
  connect: (options) => LanDiscovery.connect(options),
  disconnect: (options) => LanDiscovery.disconnect(options),
  sendMessage: (options) => LanDiscovery.sendMessage(options),
  addListener: (eventName, listener) =>
    LanDiscovery.addListener(eventName as never, listener as never),
}

/** T07 本地 WSS 服务器 transport（电脑腿 A；app 壳内） */
export const lanLocalServerTransport: LocalServerTransport = {
  startLocalServer: (options) => LanDiscovery.startLocalServer(options),
  stopLocalServer: () => LanDiscovery.stopLocalServer(),
  sendLocalMessage: (options) => LanDiscovery.sendLocalMessage(options),
  getLocalAddresses: () => LanDiscovery.getLocalAddresses(),
  addListener: (eventName, listener) =>
    LanDiscovery.addListener(eventName as never, listener as never),
}
