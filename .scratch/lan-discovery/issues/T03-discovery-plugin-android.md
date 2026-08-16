# T03: 原生发现插件 Android（NsdManager + 跨平台互操作）

- 状态：✅ 代码完成（2026-08-16，Android 实现 + 壳就位）；真机验证待用户（需 Android Studio/SDK + 设备）
- 阻塞：无
- 被阻塞者：T04, T06
- 引用：ADR-0009 决策 1/7；SPEC §5.5

## 完成记录（2026-08-16）

- `plugins/lan-discovery/`：共享 facade 由 T02 会话定义（index.ts/txt.ts/registry.ts/web.ts）；**Android 实现本票**：`android/`（NsdManager 广告/浏览 + multicast lock + 串行 resolve 超时兜底 + Android 13+ NEARBY_WIFI_DEVICES 运行时授权 + 生命周期挂起/恢复 + 事件 deviceFound/deviceLost/permissionDenied + StartResult 契约 + getStatus），契约与 T02 facade 对齐（含 deviceFound 载荷附 host 附加字段供 T04）
- Android 壳：`npx cap add android` 脚手架就位（`@capacitor/android@^8.5.0`）；插件经 cap sync 链接（android/capacitor.settings.gradle + capacitor.build.gradle 含 :lan-discovery）
- 接线：package.json 依赖 `lan-discovery: file:plugins/lan-discovery`；vite.config test include 加 `plugins/**/*.test.ts`；tsconfig.app.json include 加 `plugins/lan-discovery/src`；.gitignore 加插件 Gradle 产物
- 测试：npm test 414/414 绿（含 T02 会话的 txt/registry 22 例）；tsc -b / oxlint / 双构建（web + app）绿
- 协调：T02 会话并行实现 iOS 侧并重构 facade（事件名、StartResult、getStatus、permissionDenied）；本票按用户决定「暂停等 T02 完成」只对齐 Android 实现，未再改共享文件

## 待办（真机）

- [ ] Android Studio 构建（本机无 Android SDK）：`cd android && ./gradlew assembleDebug`（AGP 8.13.0 / Gradle 8.14.3 / JDK 21+；本机 Java 25 可能需降级）
- [ ] 真机：Android 13+ 首次运行时授权弹窗确认（NEARBY_WIFI_DEVICES）；Android↔Android 发现/消失/重发现
- [ ] **Android↔iOS 互发现（真机两台，各方向，T02 已完成 2f357dc）**：服务类型匹配、TXT 解析（UTF-8/大小写归一化差异）、消失检测
- [ ] 若互发现失败：记录差异，评估「同平台发现 + 跨平台降级 QR」（ADR-0009 后果已预列）

## 合并收尾（2026-08-16，T02 提交后）

- plugin package.json 补回 `android` 的 capacitor 入口与 files 项（T02 提交时只留 ios）；`npx cap sync android` 后 `:lan-discovery` 链接保持 ✓
- 根 package.json 无重复键（T02 提交已规范化）；`@capacitor/android` 由本票加 ✓
- 服务名对齐：Android 广告服务名改为 deviceId（镜像 iOS 实例名 = deviceId，免重名自动改名；显示名在 TXT["name"]），resume 重建路径同步修正 ✓

## 代码评审修复（/code-review 双轴：Standards + Spec）

- **resolve 代际门闩**（两轴同报的高/中危并发 bug）：10s 超时后迟到的 resolve 回调原会清掉「下一个」解析的状态 → 并发 resolve；现以 `resolvingName` 作门闩，过期回调一律丢弃（completeResolve）；解析中 lost 清门闩、迟到 found 不再出现于 lost 之后 ✓
- **失败回调清状态**：onRegistrationFailed / onStartDiscoveryFailed 即停并清 advertising/browsing/listener（getStatus 不撒谎、重试不被幂等吞掉，iOS 同语义）✓
- **stopBrowsing 5s 超时兜底**：onDiscoveryStopped 与 resolve 同类可能不触发 ✓
- **刷新 announce 重发**：已发出设备收到 mDNS 周期重播时重发缓存事件（刷新 JS 侧 lastSeen，registry.ts TTL 兜底不误删活设备）✓
- **RX 过滤对齐 iOS**：name/id/ver 必填、port 1..65535、kind ∈ phone/tablet/desktop（畸形 TXT / 同名服务类型其他 App 一律忽略）✓
- **权限收敛**：manifest 去掉未使用的 ACCESS_NETWORK_STATE（SPEC §5.5 仅 INTERNET + CHANGE_WIFI_MULTICAST_STATE）✓
- **服务类型尾点号容差**：onServiceFound 匹配去尾点比较 ✓
- **pendingCall 同步**：binder 回调线程与 main 线程间 pendingRegister/BrowseStart/BrowseStopCall 读写加 synchronized（防迟到回调丢 resolve 导致挂起）✓

## 备注
- 与 T02 的桥 API 签名一致（同一套 JS 接口，双平台实现）✅（对齐 T02 facade：startAdvertising/stopAdvertising/startBrowsing/stopBrowsing/getStatus + deviceFound/deviceLost/permissionDenied 事件 + StartResult）
- NsdManager 已知坑已处理：服务名重复（自动改名，id 为稳定键）、注册回调异步（pendingRegisterCall 收尾）、multicast lock 泄漏（referenceCounted(false) + 全路径释放）

## 目标
Android 端 mDNS 广告/浏览（NsdManager），与 iOS Bonjour（T02）互发现验证。跨平台互操作是 ADR-0009 最大技术风险，本票必须真机验证。

## 验收标准（done when）
1. Android app 广告/浏览同一服务类型 `_localtranfer._tcp`，TXT 同 T02 schema（RFC 6762/6763 编码，含大小写与值类型差异）
2. Android↔Android 互发现（发现/消失/重发现）
3. **Android↔iOS 互发现（真机两台，各方向）**——服务类型匹配、TXT 解析（UTF-8/长度）、消失检测
4. 权限：`INTERNET` + `CHANGE_WIFI_MULTICAST_STATE`（multicast lock 持有/释放）；Android 13+ 是否需要 `NEARBY_WIFI_DEVICES` 一并在真机确认
5. 与 T02 的桥 API 签名一致（同一套 JS 接口，双平台实现）

## 备注
- 若 Android↔iOS 互发现失败（TXT 或查询兼容问题）：记录具体差异，评估「同平台发现 + 跨平台降级 QR」是否可接受（ADR-0009 后果已预列）
- 参考 NsdManager 的已知坑：服务名重复、注册回调异步性、multicast lock 泄漏
