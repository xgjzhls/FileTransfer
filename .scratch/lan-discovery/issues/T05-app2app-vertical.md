# T05: app↔app 垂直打通（发现→信令→数据面→传输最小可用）

- 状态：✅ 代码完成（2026-08-16：src/lan/lanSession.ts 会话编排 + lanTransport 适配 + 23 单测（含 lanLink 双设备握手契约测试）；Home 接线：mDNS 发现区块 + 点选连接 → 原生信令（T04）→ WKWebView WebRTC（分支 A）→ 现有传输/续传/OPFS 零改动；双发起双向均可；断线 → 重新发现 → 原生重连 → bitfield 续传；信道存续但 WebRTC 单独失败时直接重 offer）
- 完成备注：`npm test` 481/481 绿（含 lan-discovery 全套 + lan 23 个）；tsc -b / oxlint / web+app 双构建绿；**待验项 = 真机**（T09 承接）：iOS↔iOS（或 iOS↔Android）发现→点选→传文件→SHA-256 一致（1GB 标准）、断线重连续传、双端同时发起竞态收敛
- 阻塞：T01, T04
- 被阻塞者：T06, T09
- 引用：ADR-0009 决策 3/6；SPEC §5.5/§6

## 目标
局域网发现区块最小可用：列出发现的 app 设备 → 点选 → 原生信令 → 数据面（spike 分支定）→ 现有传输/续传/导出生效。垂直 tracer bullet。

## 验收标准（done when）
1. 真机 iOS↔iOS（或 iOS↔Android）发现 → 点选 → 传文件 → SHA-256 与源一致（复用 .scratch/transfer T05 的 1GB 标准）
2. 发送与接收双向均可发起
3. 断线重连：重新发现 → 原生信令重连 → 从 bitfield 断点续传（§3.4 不变）
4. 分支 A：数据面走 WKWebView WebRTC，传输/续传/OPFS 零改动（本票重点是信令→PC 的接线）
5. 分支 B：原生 TCP 数据面 + OPFS 写桥，吞吐对齐分块桥量级（~177MB/s 参考，峰值内存 = 块大小），framing/bitfield 续传语义与 §3 一致
6. UI 仅最小可用：局域网区块列表 + 点选连接 + 传输区复用现状

## 备注
- 分支 B 的工作量显著大于 A：传输协议需在原生层或桥接重写——若 spike 判 B，本票扩大为两阶段（先 iOS↔iOS 原生直传闭环，再补双平台）
- 数据面与现有传输协议（meta/resume_manifest/part_done，SPEC §3）的兼容性：分支 B 需原生层对齐这些消息语义

## 实现记录（T05 落地，分支 A）

> 分支 A 已定（T04 设计定稿：WKWebView DataChannel 可用，原生只管发现+信令）。本票 = 信令→PC 接线 + 最小 UI，传输/续传/OPFS 零改动（验收 4）。

- **src/lan/lanSession.ts**（LanDiscoverySession，纯 JS 可注入 transport）：start = 订阅事件 → startSignalingServer（PORT_IN_USE 依次 8443/8444/8445，SPEC §5.5）→ startBrowsing → last-seen TTL 轮询；stop 回滚；设备注册表（DeviceRegistry）维护；connectTo（幂等）/ disconnect / sendSignal（活跃通道门控）；peerConnected 记录活跃通道（peerId → session 配对键，T04 设计：瞬态以最终 session 幂等处理）；事件透传（messageReceived → SignalPayload，与 WS/QR 同构）；错误码映射 describeLanError（CHANNEL_ERRORS 词汇 + PERMISSION_DENIED_MARKER 复用）
- **src/lan/lanTransport.ts**：生产 transport 适配（lan-discovery facade → LanTransport 接口；facade Proxy 校验保留）
- **接线（Home.tsx，重点）**：
  - transportRef 路由：ConnectionManager 的 signal 按当前载体走 ws（在线房间）或 lan（原生通道 sendSignal）
  - 点选设备 → session.connectTo → peerConnected(role=initiator) → connectTo 建 offer 经原生通道发出；role=receiver → 等 offer → handleOffer 回 answer（双发起竞态由原生消解，低 deviceId 胜）
  - messageReceived → routeSignal（offer/answer 分发与 WS 共用同一 ConnectionManager）
  - 断线（验收 3）：peerDisconnected → 标记中断 + 重新发现（注册表/等待 rediscovery 自动重连，60s 窗口）→ 原生重连 → 新 offer → connState 恢复 → resumeSend 从 bitfield 续传；信道存续但 WebRTC 单独失败 → 直接 reconnectTo 重 offer；重试封顶 3 次转手动
  - 最小 UI（验收 6）：局域网设备区块（列表 + 点选连接 + 已连接标记 + 状态/错误/端口行）；传输区复用现状
- **测试**：lanSession 19 个（生命周期/端口回退/注册表/connect/事件透传/错误文案）；lanLink 4 个（双设备握手契约：A 点 B、B 点 A、NOT_CONNECTED、断线拒绝）
- **真机待验（T09 承接）**：iOS↔iOS 发现→点选→1GB 传输 SHA-256 一致（验收 1，复用 .scratch/transfer T05 标准）；断线重连续传（验收 3）；双端同时发起竞态收敛（T04 探针已验证通道层，本票验证全链路）

## Comments

- 2026-08-16：代码完成。已按 /code-review 双轴评审修正：错误码统一走 CHANNEL_ERRORS/PERMISSION_DENIED_MARKER 词汇；Home 改经 session.sendSignal（活跃通道门控）而非直连 facade；通道存续时 WebRTC 单独失败可直接重 offer（修复卡死态）；StrictMode 代际守卫覆盖 peer 事件；抽取 routeSignal 消重；删除死代码。
