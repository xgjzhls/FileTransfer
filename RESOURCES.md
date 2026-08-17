# WebRTC / P2P 资源清单

> 知识来源只从本清单取，不靠模型记忆。引用时都回链到这里。

## Knowledge

### 第一课已用（信令面/数据面、SDP offer/answer）

- [MDN: Signaling and video calling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling)
  官方级权威。信令服务器是黑盒、「WebRTC 未规定信令传输方式（WebSocket 到信鸽都行）」、offer/answer 流程与 ICE 候选者交换。**第一课主来源**。
- [MDN: WebRTC connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)
  会话描述（SDP）是什么、local/remote description、ICE 候选者类型（host/srflx/prflx/relay）、控制方选择、完整流程图。第 2/4 课主来源。

### 建连全流程（第 2 课）

- [RFC 8841: SDP Offer/Answer for SCTP over DTLS](https://www.rfc-editor.org/rfc/rfc8841.html)
  DataChannel 的 m= 行（<code>m=application … UDP/DTLS/SCTP webrtc-datachannel</code>）、sctp-port、max-message-size（缺省 64K）、setup 角色。§13.1 有完整 offer/answer 示例。<b>第 2 课主来源</b>。
- [MDN: Using WebRTC data channels — message size limits](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
  现代浏览器单条消息 ≥256KB；缺省 64KB；无交错时大消息会头阻塞。
- [RFC 8866: SDP（Session Description Protocol）](https://datatracker.ietf.org/doc/html/rfc8866)
  SDP 格式权威定义。读真实 offer 时对照字段用。
- [Webex Engineering: Understanding SDP offer/answer negotiation](https://blog.webex.com/engineering/understanding-sdp-offer-answer-negotiation/)
  工程视角的 offer/answer 图解，可作第二来源。
- [MDN: Perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
  协商的规范状态机、避免「撞车」的完美协商模式。后续可讲。

### 数据面（第 7 课）

- [RFC 8831: WebRTC Data Channels](https://www.rfc-editor.org/rfc/rfc8831.txt)
  SCTP over DTLS over ICE/UDP 栈、有序/乱序、可靠/部分可靠、PPID、消息大小与交错建议。<b>第 7 课主来源</b>。
- [RFC 8832: WebRTC Data Channel Establishment Protocol (DCEP)](https://www.rfc-editor.org/rfc/rfc8832.txt)
  DATA_CHANNEL_OPEN/ACK 消息格式、Channel Type 字节（0x00 可靠有序 / 0x80 乱序位 / 部分可靠）、奇偶流 ID 规则。
- [MDN: RTCDataChannel.bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount)
  bufferedAmount / bufferedAmountLowThreshold / bufferedamountlow —— 浏览器背压 API 语义。

### NAT 与穿透（第 3–6 课）

- [RFC 8489: Session Traversal Utilities for NAT (STUN)](https://www.rfc-editor.org/rfc/rfc8489.txt)
  现行 STUN 规范（取代 5389）。报文头格式（§6，含 type 位图与 class/method 交错编码）、长期凭据（§9.2，key = MD5(user:realm:pass)）、FINGERPRINT（§14.5）。**第 8 课主来源**。
- [RFC 8656: Traversal Using Relays around NAT (TURN)](https://www.rfc-editor.org/rfc/rfc8656.txt)
  现行 TURN 规范（取代 5766）。方法表（§13：Allocate 0x003…）、属性表（§14：REQUESTED-TRANSPORT 0x0019 等）、Allocate 认证流程（§4.2 完整报文示例）。**第 8 课主来源**。
- [coturn 官方 Docker 镜像文档](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md)
  本地跑 TURN 服务器的官方做法（端口映射/CLI 选项）。第 8 课 demo 3 前置。

- [RFC 3489: STUN（含 NAT 四分类）](https://www.rfc-editor.org/rfc/rfc3489.html)
  全锥 / 限制锥 / 端口限制锥 / 对称 NAT 的权威定义（§5）；STUN 不适用于对称 NAT。**第 3 课主来源**。
- [RFC 8445: Interactive Connectivity Establishment (ICE)](https://www.rfc-editor.org/rfc/rfc8445.html)
  权威协议文档：候选者收集、配对与优先级、连通性检查（STUN Binding Request）、控制/被控角色、提名、保活。**第 4 课主来源**。
- [getstream.io: What is the ICE protocol?](https://getstream.io/blog/what-is-ice-protocol/)
  工程师友好的 ICE 综述：四类候选、连通性检查序列、trickle、调试清单（chrome://webrtc-internals、getStats 取 nominated pair）、consent freshness。**第 4 课第二来源**。
- [RFC 7675: Session Traversal Utilities for NAT (STUN) Usage for Consent Freshness](https://www.rfc-editor.org/info/rfc7675)
  连接后持续重探、30 秒无应答停发 —— keepalive 的协议化。
- [RFC 8838: Trickle ICE](https://www.rfc-editor.org/info/rfc8838)
  候选边收集边发送的规范。
- [Wikipedia: UDP hole punching](https://en.wikipedia.org/wiki/UDP_hole_punching)
  打洞原理（含端点独立/依赖映射的图示），第 5 课用。
- [Ford, Srisuresh & Kegel: Peer-to-Peer Communication Across Network Address Translators (USENIX 2005)](https://www.usenix.org/legacy/event/usenix05/tech/general/full_papers/ford/ford.pdf)
  打洞的经典论文（NAT 分类的出处），第 3/5 课用。

### 总览/心智模型

- [Mozilla Hacks: WebRTC and the Ocean of Acronyms](https://hacks.mozilla.org/2013/07/webrtc-and-the-ocean-of-acronyms/)
  一张图看懂 SDP/ICE/STUN/TURN 关系，适合每课回看。
- [webrtc.org: Getting started — peer connections](https://webrtc.org/getting-started/peer-connections)
  官方入门，偏 API。

## Wisdom (Communities)

- [r/WebRTC](https://reddit.com/r/WebRTC)
  活跃的 WebRTC 社区，适合问「为什么我的 DataChannel 在 X 环境下失败」这类真实现场问题。
- [discuss-webrtc（Google 群）](https://groups.google.com/g/discuss-webrtc)
  官方讨论组，规范/实现层面的深问去处。

> 注：用户尚未表态是否愿意加入社区；未确认前不在课程里推。

## Gaps

- 暂无缺口；后续讲到 TURN 部署成本时再补充运营视角的资料。
