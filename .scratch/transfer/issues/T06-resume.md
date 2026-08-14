# T06: 续传 —— manifest + bitfield + 自动重连

- 状态：待实现
- 阻塞：T05, T09（信令 WS 自动重连，前置）
- 被阻塞者：T08
- 引用：SPEC §3.4/§4；ADR-0005（决策 D1）

## 目标
中断后的无感续传：接收端持久化权威状态（manifest + bitfield），重连后只补缺失 64MiB 续传块。

## 验收标准（done when）
1. 接收端持久化：IndexedDB manifest（sessionId、文件、每 part 的 done/partial + bitfield base64，粒度 64MiB）；节流写入（≤2s，崩溃最多重传 64MiB+在途）
2. 续传握手：新通道建立 → 发送端 meta → 接收端 `resume_manifest` → 发送端只发缺失续传块（done 跳过、partial 补 bitfield 空洞）
3. 发送端重载恢复：重新选文件按 name+size 匹配继续；localStorage 缓存每文件已完成 part 数用于进度显示
4. 在线自动重连：DataChannel 断开 →（WS 自动重连由 T09 提供）→ 重新 signal → resume 握手；离线则提示重新扫码（T07 后支持）
5. 断连恢复测试：传输中途杀页面/断网，恢复后 SHA-256 一致且重传量 ≈ 缺失量（不重传已收数据）
6. 会话管理 UI：未完成会话列表（续传/删除）；30 天自动清理标记

## 备注
- 权威状态在接收端（持有数据的一方）；发送端状态可丢
- 崩溃丢 ≤64MiB + 在途属预期（bitfield 粒度 64MiB，ADR-0005 修订）
