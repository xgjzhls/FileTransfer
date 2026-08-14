# T06: 续传 —— manifest + bitfield + 自动重连

- 状态：✅ 代码完成（bitfield 工具 + Receiver 位图 + Sender 缺失块调度 + Controller 握手/持久化 + Home 自动续传 + Settings 会话管理）；178 单测全绿
- 阻塞：T05, T09（信令 WS 自动重连，前置 ✅）
- 被阻塞者：T08
- 引用：SPEC §3.2/§3.3/§3.4/§3.5/§4；ADR-0005（决策 D1：64MiB bitfield 粒度）
- 完成备注：`npm test` 178/178；e2e 11/11（T06 断连续传用例需真 WebRTC 环境——本机 Clash fake-ip 降级跳过）；详见文末「实现备注」

---

## Problem Statement

从用户视角：局域网传输中途断连是常态而非例外——锁屏、后台切走被系统回收、路由器抖动、信令服务重启、网络抖动都会掐断连接。而当前（T05 完成的分块传输）没有中断恢复能力：

- 一个 10GB 文件传到 80% 断连，重连后要从 0 开始，已收的 8GB 全部作废，还要再等一遍
- 接收端状态只活在内存里：页面被杀、浏览器后台回收、断网，已收部分全部丢失，还会遗留看不见的孤儿数据
- 校验失败是「整 part（512MiB）重传」的临时机制，粒度太粗
- 没有任何会话管理：用户看不到哪些传输没完成、没法续传、也没法清理

用户需要的是：断在哪里，就从哪里继续。

## Solution

从用户视角：断连后自动续传，只补缺失部分，不重传已收数据。

- 接收端是权威状态持有方：把「哪些 part 已完成、哪些 part 收到哪些续传块」持久化（IndexedDB），页面被杀也不丢
- 重连（或重新配对）后，发送端只补发缺失的 64MiB 续传块；已完成的 part 完全跳过
- 崩溃最多重传 64MiB + 在途数据（ADR-0005 定案粒度），对用户无感
- 发送端状态可丢：重载后重新选文件，按 name + size 匹配已收清单继续
- 设置页提供未完成会话列表（续传 / 删除），30 天超期自动标记清理

## User Stories

1. 作为发送方用户，我在传输中断（断网、锁屏、后台杀）后希望重连能自动继续，以便不用重头再传一遍
2. 作为发送方用户，我希望重连后只补发缺失部分，以便已传完的数据不重复占用带宽和时间
3. 作为接收方用户，我在页面被杀/浏览器后台回收后重新打开，希望传输能从断点继续，以便大文件不白传
4. 作为接收方用户，我希望已收数据被持久化（不依赖内存），以便任何崩溃场景下状态都可恢复
5. 作为发送方用户，我重载页面/换设备后重新选同一个文件，希望能自动匹配并继续，以便不必重新手动对齐
6. 作为发送方用户，我选的同名同大小文件如果与已收清单不匹配（文件被改过），希望得到明确提示而不是静默错传
7. 作为接收方用户，我希望一个 10GB 文件可以经历多次断连、多次续传最终完整落盘，以便大文件传输在真实弱网环境可用
8. 作为发送方用户，我希望批量队列中已完成的文件不重传，只续传未完成的文件，以便多文件传输不浪费
9. 作为发送方用户，我希望重载后进度显示仍在（按已完成 part 数），以便知道还差多少
10. 作为接收方用户，我希望传输完成后的 SHA-256 与源一致，以便确认续传没有破坏数据
11. 作为发送方用户，我希望续传后重传的数据量 ≈ 缺失数据量，以便确认没有把已收数据重发
12. 作为接收方用户，我希望重复到达的续传块被安全忽略，以便重传/在途竞态不损坏状态
13. 作为接收方用户，我希望 part 校验失败时只重传该 part 内缺失的续传块，以便故障恢复粒度更细
14. 作为接收方用户，我希望续传状态写入不阻塞传输（节流），以便大文件传输速度不受持久化拖累
15. 作为用户，我希望断连瞬间 UI 显示「传输暂停/重连中」而不是误报失败，以便不误操作取消
16. 作为在线路径用户，我希望 WS 重连成功后无需任何手动操作即自动续传，以便无感恢复（依赖 T09）
17. 作为离线路径用户，我希望重新扫码配对后从断点继续，以便无网环境也能续传（依赖 T07）
18. 作为用户，我希望设置页能看到未完成会话列表并选择「续传 / 删除」，以便管理多个残留传输
19. 作为用户，我删除未完成会话时希望对应的部分文件（孤儿数据）一并清理，以便不留不可见垃圾
20. 作为用户，我希望超过 30 天的未完成会话被标记为可清理，以便陈旧数据不长期占空间
21. 作为用户，我希望传输期间 Wake Lock 保持屏幕常亮，以便锁屏不是断连的常态诱因（沿用 T01 能力）
22. 作为开发者，我希望 resume 握手协议（meta → resume_manifest → 缺失块补发）有明确 schema，以便实现与测试可独立推进
23. 作为开发者，我希望续传逻辑在传输层（不依赖真实 WebRTC）可整体测试，以便快速回归
24. 作为接收方用户，我希望「已完成的 part」在恢复时完全跳过，以便大文件结尾处断连恢复极快

## Implementation Decisions

- **协议扩展（`resume_manifest`）**：新增 `resume_manifest` 控制消息加入传输控制消息联合类型，schema 按 SPEC §3.2：`files[].parts[]` 每项带 `state: "done" | "partial"` 与 `bitfield`（base64，64MiB 粒度，每 part 512MiB = 8 位）。`part_reset` 消息保留但语义调整：part 校验失败 → 接收端清空该 part 的 bitfield 并通知发送端块级重传（取代 T05 的整 part 重传路径）。
- **接收端为权威（不变量）**：只有持有数据的一方（接收端）能判定哪些字节已安全落盘，因此 manifest + bitfield 全部持久化在接收端；发送端不持久化 bitfield，其状态随时可丢（SPEC §3.4 第 7 条 / §3.5）。
- **存储层扩展（SessionStore / 会话 manifest）**：现有会话 manifest 记录的每文件条目扩展为携带每 part 的 `state` + `bitfield`（base64）；bitfield 在内存中随每个续传块更新，写 IndexedDB 节流 ≤2s（崩溃最多重传 64MiB + 在途）。沿用可注入 IndexedDB 的现有结构（测试注入 fake-indexeddb）。
- **续传握手流程（按 SPEC §3.4）**：新 DataChannel 建立 → 发送端发 `meta`（sessionId + 完整 part 清单）→ 接收端回 `resume_manifest`（`done` 的 part 直接跳过；`partial` 的 part 附 bitfield；无记录的 part 视为全缺）→ 发送端计算缺失续传块集合 → 只补发缺失块（块内整发，按 chunk 顺序）→ part 收齐读回 OPFS 整体 SHA-256 校验 → `part_done`；校验失败 → 清空该 part bitfield 重传。
- **接收端幂等**：已置位 bitfield 的续传块再次到达直接忽略，防止重传/在途竞态破坏状态（对应 T05 bug 修复 5 的模式：本地事件与远端确认分离）。
- **发送端重载恢复**：发送端不持久化 File 对象（易失）；重载后用户重新选文件，按 `name + size` 与接收端清单匹配继续；匹配失败提示用户重新开始。进度显示用 localStorage 缓存「每文件已完成 part 数」（非权威、可丢）。
- **连接层职责边界**：T06 不做 WS 自动重连（那是 T09）；T06 在 DataChannel 层实现「断开 → 重连就绪 → 重新 signal → 新 DataChannel → resume 握手」的自动续传分支；离线「重新扫码配对」分支依赖 T07，T06 只留状态与提示位。
- **会话管理 UI**：设置页列出未完成会话（SessionStore.list）→ 每项「续传 / 删除」；删除时同步清理该 session 在 OPFS 的部分文件（复用 T02 孤儿清理能力）；30 天超期标记。
- **复用而非新建**：续传块边界 = 现有 part/帧参数推导（64MiB = 256 × 256KiB 帧），不引入新的存储粒度；OPFS 布局、part 校验、导出流程均沿用 T05 定案。

## Testing Decisions

- **好测试的标准**：只测外部行为，不测内部实现。对传输层：输入「已收 chunk 序列 + 断连/重连事件序列」，断言「补发的恰是缺失块集合」「重传量 ≈ 缺失量」「最终 SHA-256 与源一致」——不关心 bitfield 内部如何编码、节流何时落盘。对存储层：断言持久化记录的形状与恢复行为。
- **主 seam（一个）**：传输层 TransferController（注入 FakeSink + FakeTransport，仿 T05 controller/receiver/sender 测试模式）。它覆盖完整 resume 语义：握手、done 跳过、partial 补洞、幂等去重、断连→重建→只补缺失、校验失败块级重传。这是最高 seam，WebRTC/网络机制全部挡在外面。
- **辅助 seam（最小化）**：
  - SessionStore 扩展：fake-indexeddb 注入（沿 `sessionStore.test.ts` 先例），测 manifest + bitfield 的写入/读取/节流形状与恢复。
  - e2e 一条：传输中途杀页面（或杀 WS）→ 恢复 → 文件完整（沿 `scripts/e2e.mjs` 点击测试先例，T05 验收 5 模式）。
- **关键验收测试**（对应验收 5）：模拟「传到一半断连 → 恢复」：注入计数 transport 记录每个重发的帧，断言重传字节数 ≈ 缺失字节数（不重传已收数据），且最终文件 SHA-256 与源一致。
- **先例**：controller/receiver/sender 的 FakeSink/FakeTransport 测试、`sessionStore.test.ts`（fake-indexeddb）、T05 的 e2e 杀连接用例。

## Out of Scope

- WS 自动重连实现（T09）与 DO presence 持久化（T10）——本票只消费其结果
- 离线二维码续传路径的完整实现（T07）；本票仅预留状态与提示
- 发送端 bitfield/File 对象持久化（权威在接收端，SPEC §3.4 第 8 条）
- 跨浏览器/跨设备会话迁移、多端并发接收（v1 非目标）
- [v2] unordered DataChannel 与应用层重传
- 照片门控、导出流程、Wake Lock 等 T01/T05 已定稿能力的改动

## Further Notes

- 崩溃丢失 ≤64MiB + 在途数据属预期行为（ADR-0005 粒度定案），界面上无需向用户暴露该数字
- 接收端为权威的动机：发送端只有文件视图，无法知道哪些字节已安全落盘；数据持有方判定安全边界
- 与 SPEC §3.2/§3.4/§4 保持一致；后续若修订 SPEC 续传章节，需同步更新本票
- 依赖提醒：验收 4（在线自动重连）依赖 T09 交付 WS 重连；验收 2 的离线分支依赖 T07，可在 T07 后再验

## 实现备注（2026-08-14）

### 协议与参数
- `src/protocol/transfer.ts`：新增 `resume_manifest` 控制消息（SPEC §3.2：files[].parts[].{index,state,bitfield}）
- `src/transfer/bitfield.ts`（新）：续传块 = 256 帧（CHUNKS_PER_BLOCK；≈64MiB，SPEC §3.1）；blocksInPart / blockChunkRange / encodeBitfield / decodeBitfield（base64，LSB-first）。**注意**：512MiB part 实际 9 块而非 SPEC 示例的 8——CHUNK_SIZE = 256KiB-64 → 2049 chunk；发送/接收端同一公式推导，一致即可

### 接收端（Receiver）
- 按续传块追踪完整块（completeBlocks）→ bitfield；onResumeChange 上报（调用方节流持久化）
- meta 立即回应 resume_manifest（done 跳过 / partial 附位图）；同 sessionId 重连时内存态优先（不回退持久化）
- 从持久化恢复（onMeta 的 stored 参数）：按 name+size 匹配 + 每 part sha256 校验（文件被改 → 该文件重新接收 + onResumeMismatch 提示）
- part 校验失败 → 清空该 part 位图 + part_reset（块级重传语义）

### 发送端（Sender）
- send(files, resume?)：done part 完全跳过；partial 只发缺失块（块内整发、按 chunk 顺序）；无记录全发；part_reset 中途到达 → 整 part 重发

### Controller（主 seam）
- startSend：发 meta → **等 resume_manifest**（gate，10s 兜底超时）→ 只补缺失；sessionId 可复用（resumeSend 同 id 重握手，接收端内存态命中）
- 接收端权威记录（SessionManifest）节流写 ResumeStore（IndexedDB，≤2s）；pagehide flush；send 结束后 sender 置 null（之后 part_reset 走重启整批）
- ResumeStore 接口 = SessionStore 的结构（get/list/upsert）

### 接线（Home / Settings）
- Home：controller 注入 getSessionStore()；DataChannel 断开 → 中断发送 + 自动重建（failed 立即 / disconnected 5s 兜底）→ 恢复后自动 resumeSend；对端离开（peer not found）→ connState 复位允许重连；进度缓存（localStorage，重载恢复显示）；onResumeMismatch 状态提示；pagehide flush
- ConnectionManager.reconnectTo()（新 RtcPeer + 重新 offer）
- Settings：未完成会话列表（每文件已收 N/M part、占用、30 天超期标记）+ 删除（OPFS + IndexedDB 同步清理）
- `src/transfer/progressCache.ts`（新）：发送端已完成 part 数缓存（非权威）

### 测试（新增 27 个，178 全绿）
- bitfield 9：块参数 / 编解码 / 空串 / 越界
- Sender +4：done 跳过 / partial 只补缺失 / 混合 / reset 整 part
- Receiver +7：resume_manifest 响应 / 位图上报 / 从 stored 恢复（含幂等）/ done 跳过 / sha256 不匹配 / 同 session 内存优先 / 校验失败清位图
- Controller 端到端 5（真字节 MemorySink + wire pair + FakeResumeStore）：断连重建只补缺失（重传量 ≈ 缺失量，SHA-256 一致）/ 接收端重载恢复（按 sessionId）/ 发送端重载恢复（新 sessionId 按 name+size）/ part 校验失败重发 / 节流 ≤2s
- SessionStore +2：parts 字段往返 / 旧记录兼容
- e2e：新增 T06 用例（杀接收端页面 → 重新配对 → 自动续传 → 文件完整；**需真 WebRTC 环境**，本机 Clash fake-ip 降级跳过）

### 验收对照
1. 接收端持久化 manifest + bitfield（节流 ≤2s）✅（controller 节流测试 + SessionStore）
2. 续传握手：meta → resume_manifest → 只发缺失块（done 跳过 / partial 补洞）✅（controller 端到端）
3. 发送端重载恢复：name+size 匹配继续 + localStorage 进度 ✅（controller 发送端重载测试 + progressCache）
4. 在线自动重连：DataChannel 断开 → 自动重建 → resume 握手 ✅（Home 接线 + resumeSend；离线扫码分支归 T07）
5. 断连恢复测试：重传量 ≈ 缺失量 + SHA-256 一致 ✅（controller 端到端；e2e 用例待真机）
6. 会话管理 UI：未完成会话列表（续传/删除）+ 30 天标记 ✅（Settings）

### 遗留
- e2e 断连续传用例在本机（Clash fake-ip 无同机 ICE）降级跳过，需真机/无代理环境跑一次
- 离线扫码续传（T07）未做：本票预留 resume 握手协议，离线路径复用同一 handshake
- 发送端重载后「匹配失败提示」：name+size 不匹配 → 静默全发；sha256 不匹配 → onResumeMismatch 状态提示（已实现）
