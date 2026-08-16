# Mission: 吃透自己的 WebRTC P2P 技术栈

## Why

用户正在开发 LocalTransfer —— 局域网 P2P 文件传输（WebRTC DataChannel + 信令双载体 WS/QR + iOS 壳）。目标是把「会做」提升为「真懂」：真正理解建连全流程（SDP offer/answer、ICE、为什么必须双向）与 NAT 穿透的底层机制，从而能自信地向别人讲解架构、独立判断技术取舍（例如为什么局域网场景天然不需要 STUN、未来如何走向互联网 P2P）。

## Success looks like

- 能不看代码，完整讲出一次传输从扫码/进房到文件落地的全过程，并且能说出每一步在解决什么问题
- 能解释「纯离线为什么至少要两跳扫码」背后的协议语义，而不是背结论
- 能解释 NAT 的类型、STUN / TURN / 打洞各自解决什么问题，以及 LocalTransfer 局域网场景为何天然避开这些
- 能讲清自己架构里每个决策的权衡：信令载体选择（WS/QR/原生通道）、DataChannel ordered/reliable、分块与续传粒度

## Constraints

- 语言：中文讲解与材料
- 教学方式：短课（10–15 分钟）+ 即时测验；每课一个能快速完成的实得收获
- 多会话进行：每会话推进一课左右，配套测验与真实世界任务
- 已有基础：用户已亲手实现 SDP offer/answer 交换（QR 压缩 + WS 明文）、DataChannel 分块传输、64MiB bitfield 续传 —— **不要从「什么是 WebRTC」讲起**，要讲「为什么」

## Out of scope

- WebRTC 媒体流（音视频）细节 —— 项目是纯数据面
- 浏览器 API 逐条罗列 —— 需要时查 MDN
- 与项目无关的通用 P2P 生态（BitTorrent / DHT 等）—— 用户明确选择先吃透自己的技术栈
