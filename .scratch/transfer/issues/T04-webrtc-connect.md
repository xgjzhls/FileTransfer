# T04: WebRTC 连接（tracer bullet）—— 发现 → signal → DataChannel → meta

- 状态：✅ 代码完成（src/signaling/ + src/webrtc/ + Home 房间 UI；76 单测）；⚠️ 验收 5 双浏览器冒烟待用户
- 阻塞：T01, T03
- 被阻塞者：T05, T07
- 引用：SPEC §3.2/§3.3/§5
- 完成备注：`npm test` 76/76；RtcPeer（可注入 pc 单测）握手/状态机/压缩 sdp 已测；ConnectionManager 握手流与 meta 收发已测；验收 5 需用户开两个浏览器标签（dev server http://localhost:5173 已就绪）

## 目标
垂直打通最小闭环：两台设备通过信令发现彼此 → 交换 SDP → DataChannel 建立 → meta 消息互通（文件清单）。本票不传文件数据。

## 验收标准（done when）
1. 房间流程：创建房间显示码 / 输码加入；设备列表（在线时）；点选设备发起连接
2. 信令封装：`signal` 单次装载（gathering complete 后取 `localDescription.sdp`，gzip+b64）——与 QR 共用 payload 结构（为 T07 留接口）
3. DataChannel：`ordered:true` reliable；连接状态机 idle→signaling→connecting→connected→(disconnected 可重连)
4. meta 消息收发：发送端组文件清单，接收端确认（UI 弹「接收 N 个文件」）
5. 双浏览器真机/桌面冒烟：同一 Wi-Fi 下连接成功

## 备注
- 候选：是否用 `pc.onconnectionstatechange` 统一状态；重连策略（指数退避）留 T06 细化，本票只做到「断开可手动重连」
- 本票完成后即 tracer bullet：可演示「发现→配对→握手」，后续票逐步加能力

## 已知问题（2026-08-14 调查）
- **现象**：经常看不到加入房间的人
- **根因 1（本地主因）**：客户端无自动重连，`ws.on('close')` 即 `setPeers([])`（Home.tsx），且无手动重连入口 → wrangler dev 重启 / Clash 抖动 / 锁屏后设备列表永久空 → ✅ **已修（T09：ReconnectingSignalingClient 指数退避自动重连 + 重 join + 列表保留）**
- **根因 2（部署必现）**：DO 用 WebSocket Hibernation API（`acceptWebSocket`）但 `RoomCore.peers` 仅存内存；DO evict 后唤醒时 core 为空 → 新设备 join 只见自己、老设备收不到广播 / 被 "join first" 拒绝 → ✅ **已修（T10：presence 持久化 + tags 重建）**
- **根因 3（dev 抖动）**：React StrictMode 双挂载 → 刷新即 join→leave→join（`device.id` 每次 mount 重新生成）；放大部分场景，保持不动
- **新发现（2026-08-14，T09 调查）**：wrangler dev 本地模式下，DO 实例在「WS close + 新 fetch」时被重建（miniflare 怪癖），内存 presence 丢失、老连接被静默丢弃（客户端收不到 close）→ A 断线后 B 在服务端消失但 B 不知情。✅ **已被 T10 的 presence 持久化缓解**：新实例从 storage 重建，A 重连后无需 B 重连即可恢复互见（e2e step 6 已验证）
