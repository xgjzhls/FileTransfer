# 已确立基线：用户亲手实现过 WebRTC 信令与 DataChannel 传输

用户已完整实现一个 WebRTC P2P 文件传输应用（LocalTransfer）：SDP offer/answer 交换（WS 明文 + QR 压缩双载体）、DataChannel 分块传输（256KiB 帧 / 64MiB bitfield 续传粒度）、Durable Object 房间信令中转。**深度：实践流利** —— 会用 API、懂自己的协议，但理论层（「为什么」）有洞：建连全流程（offer/answer 为何必须双向、SDP 内容、ICE 候选者）与 NAT 穿透，是用户自己点名的两个盲区。

**Implications**：后续课程一律从「为什么」切入，不重讲 API 基础；第 2 课起用用户真实 SDP（qrCodec 产物）和真实代码做教具。NAT/ICE 部分需从局域网场景过渡到互联网场景讲（用户项目当前零 STUN/TURN，局域网天然避开 NAT）。

**Evidence**：本会话问询（用户选择「吃透自己的技术栈」「建连全流程 + NAT 与穿透」）；代码阅读（src/protocol/signaling.ts、server/src/roomDo.ts、SPEC.md、ADR-0002/0004/0005/0007）。
