# T02: 原生发现插件 iOS（mDNS 广告/浏览）

- 状态：✅ 代码完成（plugins/lan-discovery/：ios/LanDiscoveryPlugin.swift + src/ facade + web 降级 + txt/registry + 22 单测；cap sync 自动注册 CAPLanDiscoveryPlugin；Info.plist 已配 NSLocalNetworkUsageDescription；模拟器 xcodebuild BUILD SUCCEEDED）
- 阻塞：无
- 被阻塞者：T04, T06, T07
- 引用：ADR-0009 决策 1；SPEC §5.5；plugins/folder-export（桥模式先例）
- 完成备注：`npm test` 428/428 绿（含 lan-discovery 22 个）；`npm run build`/`build:app` 通过；Spike 页新增「测试 5」探针供真机验收；**待验项 = 验收 5（两台 iOS 真机互发现：发现→消失→重发现）**，人类步骤走 Spike 页

## 目标
Capacitor 插件（仿 folder-export：原生 ↔ JS 桥，cap sync 自动注册）：iOS 端 mDNS 广告 + 浏览，TXT 携带设备信息。

## 验收标准（done when）
1. 插件原语可用：`startAdvertising` / `stopAdvertising` / `startBrowsing` / `stopBrowsing`（JS 桥 API 对齐 folder-export 风格）
2. 广告：服务类型 `_localtranfer._tcp`；TXT 记录（RFC 6763）`name`（设备名）/`id`（deviceId uuid）/`kind`（phone/tablet/desktop）/`port`（信令端口，T04 用）/`ver`；值 UTF-8 且 ≤255B
3. 浏览：发现回调（设备名/ID/类型/信令端口）、消失检测（对方停止广播/断网 → TTL 内移除）
4. `NSLocalNetworkUsageDescription` 配置 + 首次授权弹窗一次；拒绝后 JS 侧可感知并提示引导重开
5. 真机：两台 iOS app 实例互发现（发现→消失→重发现）

## 实现记录（T02 落地）
- **广告 API 勘误**：iOS SDK **无 `NWAdvertiser` 类**（对照 iOS 18.5 SDK swiftinterface 核实；Apple 文档的广告姿势 = `NWListener` + `service` 属性，TN3213 佐证）→ 用 NWListener(.tcp, port .any) + `NWListener.Service(type:_localtranfer._tcp, name: id, txtRecord:)`，`newConnectionHandler` 直接 cancel（广告监听器不接受连接；信令端口在 T04）
- **实例名 = deviceId**（稳定唯一，避免重名冲突/自动改名）；显示名在 TXT["name"]
- **消失检测**：NWBrowser `browseResultsChangedHandler` 的 `.removed` 变更 → `deviceLost` 事件；JS 侧 `DeviceRegistry.pruneStale(ttlMs, now)` last-seen 兜底（mDNS TTL 默认 120s，不即时移除）
- **权限拒绝检测**：listener/browser `.failed` 时识别 `NWError.dns(-65570)`（kDNSServiceErr_PolicyDenied）/ posix EPERM/EACCES → `permissionDenied` 事件 + `getStatus()`；恢复（.ready）后自动清除标记
- **JS facade**：`validateAdvertisingOptions` 抛 `LanOptionsError`（TXT ≤255B UTF-8 / kind 三枚举 / port 1..65535），Proxy 包装 registerPlugin 返回值 → 非法参数先于原生被拦；web 降级（WebPlugin）明确报错
- **前后台生命周期（记录）**：退后台（willResignActive）→ iOS 挂起停 mDNS，显式 cancel 干净停；回前台（didBecomeActive）→ 按上次参数重启广告/浏览（was* 标志）

## 备注
- Network.framework：NWAdvertiser/NWBrowser → 实际 NWListener.service/NWBrowser；接口生命周期与 app 前后台切换行为见上「实现记录」
- 消失检测依赖 mDNS TTL（默认 120s），列表需按「最后看到时间」清理而非即时 → `DeviceRegistry.pruneStale`（Spike 页 30s 轮询兜底）
- TXT 编码 UTF-8 与 Android NsdManager 的互操作风险见 T03（跨平台真机验证）
