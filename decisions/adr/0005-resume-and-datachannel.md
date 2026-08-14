# ADR-0005: 传输协议 —— bitfield 粒度续传 + ordered DataChannel

- 状态：已接受
- 日期：2026-08-13

## 背景
- 需求：单文件 ≤10GB、批量、**自动续传**（中断后不重传已收数据）
- spike 已验证接收端可用 OPFS + `createSyncAccessHandle`（Worker 内随机写）
- 协议分层：part（512MiB，存储/校验/续传已完成单位）+ chunk（1MiB，传输单位）

## 决策
1. **续传粒度 = chunk（bitfield）**：接收端为权威状态，manifest + 每 part 的接收 bitfield（base64）持久化在 IndexedDB（节流 ≤2s 或每 32 chunk）；重连后经 `resume_manifest` 交换，发送端只补缺失 chunk。part 收齐后整体 SHA-256 校验，失败则该 part 清空 bitfield 重传。
2. **DataChannel 用 `ordered:true` + reliable**（v1）。chunk 自带 (fileId, partIndex, chunkIndex) 偏移，接收端按偏移随机写盘 —— 未来切 unordered 不改变写盘逻辑。

## 理由
- 中断是常态（Wi-Fi/锁屏/后台杀进程）：bitfield 让每次中断损失 ≤32MiB（持久化节奏），整 part 重传则 ≤512MiB；10GB ≈ 20 parts，反复中断会放大差距
- ordered + reliable：局域网丢包低，SCTP 自带顺序与可靠，**零应用层重传逻辑**，v1 最简
- 发送端 File 对象易失：权威状态放接收端（持有实际数据的一方），发送端重载后按 name+size 匹配继续

## 后果
- 正面：中断损失极小、无感续传、接收端重启/发送端重载都可恢复
- 负面：
  - 接收端需持久化 manifest/bitfield（IndexedDB 节流写入）
  - 续传握手增加复杂度（resume_manifest 交换）
  - ordered 吞吐在丢包高的链路上不如 unordered（[v2] 再评估；写盘路径已兼容）

## 修订（2026-08-14，Q2 讨论）
- **chunk 实为 256KiB 传输帧**：DataChannel maxMessageSize（Chrome/WebKit 262144）硬上限，实测 1MiB 消息抛错；本文「1MiB chunk」描述作废，以 SPEC §3.1 为准
- **续传粒度定为 64MiB 续传块**（决策 1 修订）：1 bit = 256 帧；每 part（512MiB）8 bit；10GB 文件共 160 bit
- 崩溃最多重传 64MiB + 在途（原设计 ≤32MiB）
- 理由：bitfield 尺寸缩小一个数量级；Sender/Receiver 仅在 64MiB 边界置位，framing 与写盘路径零改动
