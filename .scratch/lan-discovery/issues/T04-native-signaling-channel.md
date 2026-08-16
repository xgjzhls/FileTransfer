# T04: 原生信令通道 app↔app（SDP 经发现直连交换）

- 状态：✅ 代码完成（2026-08-16：channel.ts 协议层 + facade/web + 30 单测（含 Node 真 TCP 集成冒烟：建连/双向收发/竞态收敛/坏帧/断线重连）；iOS 信令服务器/连接（NWListener+NWConnection，SRV=信令端口统一，xcodebuild BUILD SUCCEEDED）；Android 同协议（ServerSocket/Socket，javac 桩编译通过，无 Android SDK 未跑 Gradle）；Spike 页「测试 5」新增 T04 探针（起服务器/连接/发 offer/answer/断开）；SPEC §5.5 增补 wire 协议/竞态/错误码）
- 完成备注：`npm test` 458/458 绿（含 T04 30 个）；tsc -b / oxlint / web+app 双构建绿；**待验项 = 真机**（T09 承接）：iOS↔iOS / iOS↔Android / Android↔Android 三组合建通道 + SDP 互发 + 双发起竞态 + 断线重连；Android 侧 Gradle 构建（无 SDK）
- 阻塞：T02, T03
- 被阻塞者：T05
- 引用：ADR-0009 决策 1；SPEC §5.1/§5.5

## 目标
发现成功后，发起方 TCP 连对端信令端口，经**原生信令通道**双向交换 offer/answer + ICE——信令「单协议多载体」的第三种载体，复用 `signal.payload` schema。

## 验收标准（done when）
1. 原生信令通道建立：发起方 TCP 连对端 `port`（TXT 里拿到），双向收发
2. 消息 schema 与 WS/QR 载体一致（offer/answer/sdp 结构复用；gzip 压缩约定同一套）
3. 喂给 WKWebView 内 RTCPeerConnection 可建连（分支 A）；分支 B 时本票改为「原生数据面握手」定义（见 T01 备注）
4. 竞态：两台同时发起 → 协商唯一通道（主动方判定/随机胜负/冲突重试），不产生双连接
5. 失败处理：端口拒绝、对方忙、超时 → 明确错误回调，JS 侧提示；重试/重新发现路径可用
6. 断线后重新发现 → 重新建通道

## 备注
- 通道加密 v1 明文（ADR-0009 后果已接受：同 LAN 信任模型）；TLS 升级留 [v2]
- 竞态设计建议：发起方生成会话 token，对端接收方若已发起则以「先到者胜 + 低 id 胜」消解

## 设计定稿（2026-08-16，分支 A 前提，TDD 实现）

> 分支依据：T01 spike 未真机验证，用户拍板按**分支 A**（WKWebView DataChannel 可用，原生只管发现+信令）推进；T04 = 纯信令通道，SDP 交给 WKWebView 内 RTCPeerConnection。

### Wire 协议（v1，明文 TCP；TLS 留 [v2]）

- **帧**：4 字节大端长度前缀 + UTF-8 JSON 载荷；帧上限 64 KiB（hello 极小、压缩 SDP 数 KB；超限 = 协议违规，关闭连接）
- **消息**（`v:1` 固定）：
  - `hello`（发起方连上即发，**只此一条，接收方不回 hello**）：`{"v":1,"type":"hello","id":"<deviceId>","session":"<uuid>"}` —— id = 发起方 deviceId（权威身份，接收方据此做竞态判定；接收方身份由发现列表已知）；session = 配对会话 token（发起方每次连接生成，双方 JS 以它作配对状态键）
  - `signal`（双向）：`{"v":1,"type":"signal","kind":"offer"|"answer","sdp":"<gzip+base64url>"}` —— 与 SPEC §5.1 `signal.payload` 同结构（kind+sdp，压缩约定与 WS/QR 同一套，sdp 对原生透明）
  - TCP 断开 = 断线（v1 无 bye）
- **端口策略**：`startSignalingServer({port, device})` 一个调用同时绑定 TCP 监听 + 挂 Bonjour（SRV 端口 = 实际监听端口 = TXT port —— 三处一致，DNS-SD 语义正确，跨平台互连全靠这一点）；port 取具体值（默认 8443，JS 遇 PORT_IN_USE 依次试 8444/8445）；不搞 0=临时端口（避免「先绑后知端口」的 TXT 蛋鸡问题）

### 竞态消解（两台同时发起 → 唯一通道）

- 判定：**低 deviceId 胜**（deviceId 字符串按 Unicode 标量字典序比较；UUID 小写十六进制，两端一致）。胜出的连接 = **由较低 id 一方发起的那条**（其出向连接存活）；双方独立套同一规则，收敛到同一连接
- 两侧动作：
  - 我 id < 对端 id：保留**我的出向**，静默关闭收到的入向（不发事件）
  - 我 id > 对端 id：关闭我的出向（发 peerDisconnected），激活收到的入向为 receiver（发 peerConnected）
- 会话一致性：幸存连接带的是低 id 方的 session，两端最终看到同一 session；被弃连接的 session 不对外
- 事件流（正常无竞态：一次 peerConnected；竞态时高 id 方可能看到 initiator→disconnected→receiver 的瞬态，JS 侧以最终 session 为键，幂等处理——T05 接线时按此设计）
- 角色语义：幸存连接的发起方 = `initiator`（T05 中即 offer 方），另一方 = `receiver`

### API（facade 新增）

- `startSignalingServer({port, device}) → {ok, port}`；`stopSignalingServer() → {ok}`
- `connect({peer: LanDevice, myId}) → {ok}`（iOS 走 `.service` 端点解析 SRV；Android 走 host:port）
- `disconnect({peerId}) → {ok}`；`sendMessage({peerId, kind, sdp}) → {ok}`（kind/sdp 先 JS 校验）
- 事件：`peerConnected {id, session, role}` / `peerDisconnected {id}` / `messageReceived {from, session, kind, sdp}` / `signalingError {peerId?, code, message}`
- `getStatus()` 增 `signaling`（服务器是否在跑）
- 错误码：`PORT_IN_USE` / `CONNECTION_REFUSED` / `CONNECTION_TIMEOUT`（10s）/ `HOST_UNKNOWN`（Android host 空）/ `PEER_MISMATCH`（hello.id ≠ 期望，v1 先不做，留错误码位）/ `NOT_CONNECTED` / `ALREADY_CONNECTING` / `PROTOCOL_VIOLATION`（坏帧/缺 hello/未知 type）/ `INVALID_PARAMS`
- web 端（浏览器）全部拒绝（无 TCP 能力，同 T02 语义）
- iOS 广告双模式：`startAdvertising` 无信令服务器时 = T02 旧行为（纯 Bonjour 广告、拒绝连接）；T04 流程用 `startSignalingServer({port, device})` 一体（广告+监听同 listener）

### 实现与验证

- JS：`channel.ts`（帧编解码/消息构建/校验/竞态判定纯函数 + 常量）→ TDD 单测 + Node 双端真实 TCP 冒烟（钉死 wire 协议）；facade/web.ts 扩展
- 原生：iOS NWListener/NWConnection、Android ServerSocket/Socket，同一协议同一竞态规则（Swift/Java 各自实现，行为对齐 TS 参考）
- 真机待验项（T09 承接）：iOS↔iOS / iOS↔Android / Android↔Android 三组合建通道+SDP 互发+竞态；Spike 页加探针
