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
