# Notes（教学偏好与工作记录）

## 用户偏好

- **语言**：全部中文（用户用中文沟通，项目文档也是中文）
- **教学方式**：短课 + 即时测验（2026 会话问询确认）；每课一个快速实得收获
- **最想补的洞**（问询）：① 建连全流程（offer/answer 为何必须双向、SDP 内容、ICE candidate、为何两跳）② NAT 与穿透
- **学习目标**：吃透自己的技术栈（MISSION.md），不是泛泛学 P2P

## 已确立的基线（详见 learning-records/0001）

用户已实现：SDP offer/answer 交换（QR 压缩 + WS 明文双载体）、DataChannel 分块传输、64MiB bitfield 续传、Durable Object 房间。
→ 教「为什么」，不教「是什么」；跳过 API 基础。

## 课程弧线（计划，随学习进展修订）

1. 0001 信令面 vs 数据面 —— 为什么需要握手、为何必须双向（已完成）
2. 0002 SDP 里写了什么 —— 逐行读 offer，对照 RtcPeer/sdpCodec（已完成）
3. 0003 NAT —— 四种 NAT 行为、为何入站被拒、对称 NAT 杀死 STUN（已完成）
4. 0004 ICE —— 候选者 host/srflx/prflx/relay、连通性检查、控制/被控、trickle（已完成）
5. 0005 UDP 打洞 —— 会合服务器、同时发包钻洞、对称 NAT 失败（已完成）
6. 0006 TURN —— Allocate/Permission/Channel、带宽成本、防开放中继（已完成）
7. 0007 DataChannel 数据面 —— SCTP 语义、DCEP Channel Type、背压对照 sender.ts（已完成 ✅ 全课程 7 课收官）

**课程已完结（7/7）。下一步选项**：① 回头重做各课测验（间隔复习、巩固存储强度）② 真实世界任务：向别人讲一遍完整链路、或在真机/webrtc-internals 上验证 ③ 深挖专题（TURN 部署、DCEP 细节、SPEC 对照）④ 若用户要跨网 P2P，加第 8 课（STUN/TURN 落地与 coturn）

## 已核实的技术事实（课程锚点，讲课时引用）

- 本项目信令是**非 trickle 单次装载**：等 icegatheringstatechange==complete 后取 localDescription.sdp 再 gzip+b64（peer.ts waitForGatheringComplete）—— QR 单载体对协议的约束
- `iceServers: []` → SDP 里只有 host 候选者；无 STUN/TURN（v1 无跨网需求）
- chunk = 256KiB−64，来源 = max-message-size 262144（RFC 8841；现代浏览器协商 256KiB）；64 字节留给帧头
- createDataChannel ordered:true 不进 SDP —— 通道参数走 DCEP 带内协商（RFC 8832）
- offer a=setup:actpass，answer 必须收敛为 active/passive；m= 行 proto 两端必须一致（RFC 8841）
- NAT 四分类（RFC 3489 §5）：全锥/限制锥/端口限制锥/对称；对称 NAT 映射每目的地一个，STUN 失效
- ICE 四步（RFC 8445 §2）：收集 → 交换 → 配对检查 → 提名；pair priority=2³²·MIN(G,D)+2·MAX(G,D)+(G>D?1:0)；检查 = 从 base 发 STUN Binding Request；prflx 优先级必须高于 srflx；relay 通常为 0
- UDP 映射空闲回收（Ford 2005：有的 20 秒）→ keepalive / consent freshness（RFC 7675：30 秒无应答停发）
- 打洞（Ford 2005 §3.2）：会合服务器换端点 → 双方同发公网端点 → NAT 各建映射；对称 NAT（每目的地一映射）失败；端口预测非稳健
- TURN（RFC 5766）：Allocate 10min 寿命需 Refresh；Permission 按 IP 授权 5min；ChannelBind 低开销；客户端↔服务器 UDP/TCP/TLS，服务器↔对端恒 UDP；TURN 分配同时给 srflx 信息
- DataChannel（RFC 8831/8832）：Channel Type 0x00=可靠有序（0x80 位=unordered）；部分可靠=REXMIT/TIMED；PPID 50=DCEP/51=String/53=Binary；无交错时建议 ≤16KB；关闭=流重置 RFC 6525
- 背压（本项目）：BACKPRESSURE_LIMIT 8MiB 暂停、bufferedAmountLowThreshold=一半 4MiB 唤醒（sender.ts + peer.ts）

## 讲课时引用用户代码的位置

- 信令协议类型：`src/protocol/signaling.ts`（SignalPayload：kind=offer|answer + sdp）
- QR 压缩：`src/qr/qrCodec.ts`、`src/qr/sdpCodec.ts`
- WebRTC 封装：`src/webrtc/`
- 服务端房间：`server/src/roomDo.ts`、`server/src/room.ts`（信令黑盒中转）
- 正式规格：`SPEC.md`；决策记录：`decisions/adr/`（ADR-0002/0004/0005/0007 最相关）
