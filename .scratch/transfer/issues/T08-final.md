# T08: 收尾 —— 照片门控、Wake Lock、孤儿清理集成、多端联调

- 状态：✅ 代码完成（Wake Lock 常亮 + 降级提示 + 取消/重试修复 + 分区一致性提示；照片门控/孤儿清理/批量队列此前已实现）；218 单测全绿；e2e 14/14（本机降级模式）
- 阻塞：T05, T06, T07
- 被阻塞者：无
- 引用：SPEC §4/§6；spike 结论（600MiB Web Share 崩溃；iOS 分区隔离）

## 目标
把所有已验证的边界条件集成进正式产品，完成多端真机联调，达到可用状态。

## 验收标准（done when）
1. 照片门控实测：真机确认门控阈值（默认 300MiB），大文件存 Files + 导入提示文案到位
2. Wake Lock（iOS 17+）：传输期间保持常亮；不可用降级提示
3. 孤儿数据清理集成：启动扫描 + 设置页一键清除（与 T02 的清理一致）
4. 分区一致性：UI 提示「请用同一浏览器/模式传输与清理」（iOS 分区隔离）
5. 多端联调：iPhone↔iPad（离线扫码）、iPhone↔Mac、批量 10 文件、10GB 级单文件、中断恢复
6. 体验走查：房间码展示/加入、配对、进度、取消/重试、断连提示全流程顺畅

## 备注
- 这是发布前的最后一票；验收即「可用 v1」
- 期间发现的协议/存储问题回填到 SPEC 与对应票

## 实现备注（2026-08-14）

### 验收核对（代码侧已完成项）
1. **照片门控** ✅（此前 T05）：`classifyExport` + `PHOTO_GATE_BYTES=300MiB`；分享面板文案区分「存储到照片 / 存储到文件」；**真机阈值确认待多端联调时执行**
2. **Wake Lock** ✅（本次）：`src/wakelock/wakeLock.ts` 状态机（idle/held/released/denied/unavailable）；传输活跃且连接在线 → `request('screen')`，结束/取消/断连 → 释放；切后台 iOS 自动释放 → 回前台自动重取；不支持/被拒 → UI 降级提示不报错；19 单测
3. **孤儿清理集成** ✅（此前 T02）：首页启动扫描横幅 + 设置页一键清理 + 清除全部
4. **分区一致性** ✅（本次）：设置页数据区 + 首页传输区底部提示「iOS 分区隔离：传输与清理必须在同一浏览器/模式」
5. **多端联调** ⏳ 真机（iPhone↔iPad 离线扫码、iPhone↔Mac、批量 10 文件、10GB 级、中断恢复）——验收清单待真机执行
6. **体验走查** ✅ 代码侧：修复「取消」按钮从不显示（`status:'transferring'` 声明但从未置位 → onProgress 置位；取消后重置回 pending 可重试）；**取消语义修正**：Sender 中止改为抛 AbortError（此前静默 return 且无条件 onFileDone → 取消会把未完成文件标「完成 ✓」、重试被过滤、接收端永久 stuck）；开始发送即置 transferring（meta 哈希期间也有取消按钮 + 常亮）；房间码/配对/进度/断连提示走查待真机

### Wake Lock 设计（SPEC §6.7）
- `WakeLockManager`：`setActive(active)` 驱动；依赖注入（wakeLock/document）便于单测；`subscribe` 通知状态；`dispose` 清理
- 状态机：
  - 传输活跃 + 连接在线 → `held`（屏幕常亮）
  - 全部完成/取消/断连 → `idle`（释放，避免断线后一直常亮耗电）
  - 请求被拒（NotAllowedError，页面不可见/策略）→ `denied`，回前台/重试自动恢复
  - 浏览器无 `navigator.wakeLock` → `unavailable`，传输中 UI 提示「屏幕常亮不可用（iOS 17+ Safari / 新版 Chrome 支持），传输期间屏幕可能休眠」
- 切后台：iOS 会释放锁 → 主动释放 sentinel（避免 stale 显示）→ 回前台重新请求
- Home 接线：`sendItems/recvItems/connState` effect 驱动；卸载时 dispose

### 测试
- `src/wakelock/wakeLock.test.ts`：20 单测（获取/幂等/并发 in-flight 守卫/释放/竞态/后台恢复/被拒重试/退订/dispose/依赖注入）
- `src/transfer/sender.test.ts`：+2 中止语义（AbortError + 不误标 done）；controller 3 处中止断言改为期待 rejection
- 全量：`npm test` 218/218；`E2E_NO_PROXY=1 node scripts/e2e.mjs` 14/14（本机 Clash fake-ip 降级模式，符合历史记录）

### 待用户真机验证（验收 1/5/6）
- 照片门控阈值实测（<300MiB 存照片 / 大文件存 Files）
- 多端联调（iPhone↔iPad 离线扫码、iPhone↔Mac、批量 10 文件、10GB 级、中断恢复）
- 体验走查全流程（房间码/配对/进度/取消重试/断连提示）

### code-review 后修复（2026-08-14 二次评审）
1. **StrictMode 双跑杀 Wake Lock**：dispose 永久化 + 渲染期懒建 → dev 下 effect 重放后 setActive 静默失效。改为在 effect 内创建/销毁实例（cleanup 置空 ref，重放重建新实例）
2. **Sender 中止语义**：`sendFile/sendPart` 对 `signal.aborted` 由静默 return 改为抛 AbortError，`onFileDone` 只在整文件发完触发——取消不再误标「完成 ✓」、重试不再丢文件、接收端不再永久 stuck；`controller.startSend` 的 `sender=null` 移入 finally（取消后 `hasActiveSend()` 归 false，避免误触发旧批次续传）
3. **Wake 生效时机**：开始发送即置 `transferring`（waitChannel/meta 哈希期间也有取消按钮 + 常亮，10GB 级哈希可达数分钟）
4. **去重**：在途判定提取 `transferActive` memo（effect + JSX 共用）；`fallbackState` getter 收敛 4 处重复；acquire 加 in-flight 守卫（并发 setActive 只 request 一次）；「released」（后台瞬态）不再触发 ⚠ 不可用提示
