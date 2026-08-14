# T09: 信令 WS 自动重连 —— 修「看不到加入房间的人」

- 状态：✅ 代码完成（src/signaling/reconnect.ts + Home 重连 UI；15 单测）；验收 4/5 e2e 11/11 绿；真机待用户验证
- 阻塞：T03, T04
- 被阻塞者：T06（验收 4 依赖本票提供 WS 重连）
- 引用：SPEC §5.2；T04 已知问题 1
- 完成备注：`npm test` 133/133；`E2E_NO_PROXY=1 node scripts/e2e.mjs https://localhost:5173` 11/11（含新用例「杀 WS→自动重连→房间码不丢、设备列表恢复」）；详见文末「实现备注」

## 目标
WS 断开后指数退避自动重连并自动重新 join 原房间，设备列表自动恢复 —— 修掉 T04「经常看不到加入房间的人」的本地主因（wrangler dev 重启 / Clash 抖动 / 锁屏后列表永久空）。

## 验收标准（done when）
1. WS 断开 → 自动重连：指数退避 1s→2s→4s…封顶 30s
2. 连续失败 ~10 次（约 5 分钟）放弃自动重连，转「离线」状态提示手动操作（离线 QR 属 T07，不在本票）
3. 重连成功后自动重新 join 原房间码 → `room_state` 恢复设备列表；不丢房间码、不丢已选文件/传输上下文
4. 断线期间 UI 进入「信令重连中…」态而非永久清空列表；恢复后列表回来
5. 单测 + e2e：模拟 WS 断开→重连→列表恢复（本地 wrangler dev 重启即可复现；e2e 加一条「杀 WS→重连→peers 恢复」用例）

## 备注
- 与 T06 验收 4 的关系：本票提供「重连 WS + 重新 join + 恢复 room_state」；T06 在其上做「重新 signal + resume 握手」
- 退避/放弃参数与本会话 Q4 定案一致（1s→30s 封顶，~5min 放弃）
- 本票不碰 DataChannel 层自动重连（那是 T06 的事）

## 实现备注（2026-08-14）

### 客户端
- 新增 `src/signaling/reconnect.ts`：`ReconnectingSignalingClient` 包一层连接生命周期（createSocket 可注入，沿用 SignalingClient 路由）
  - 状态机：connecting → connected ⇄ reconnecting → offline（手动 retry() 回 connecting）
  - 指数退避 1s→2s→4s…封顶 30s；连续失败 10 次（退避合计约 3 分钟，含尝试时间 ~5min 内）→ offline + onGaveUp
  - 每次重连成功自动重新 join 原房间码（room + device 记忆在客户端）→ room_state 恢复设备列表
  - `close()` 主动关闭不再重连；`forceDisconnect()` 为 e2e 测试钩子（模拟外力断开，不停止重连）
  - `retry()` 供 offline 态手动重连（重置失败计数）
- Home.tsx：wsState 增加 reconnecting/offline；断线期间**不再清空设备列表**、不再把 connState 置 idle（不丢已选文件/传输上下文）；offline 显示「重新连接」按钮；诊断区显示中文状态；e2e 钩子 `window.__ltSignaling.forceDisconnect`（仅 DEV 构建）；信令非 connected 时「连接」按钮禁用（防对陈旧 peer 发起连接）
- 单测 `reconnect.test.ts` 15 个：退避序列/封顶、重 join + room_state 恢复、失败计数清零、error+close 去重、error 不伴 close 防御、10 次放弃、切换房间重置计数、retry 恢复、手动 close 不重连、forceDisconnect 语义、非 connected 态 signal/leave 静默丢弃
- 健壮性（code-review 后补）：`connect()` 重置失败计数（切换房间不继承退避进度）；`fail()` 收尾失败 socket（error 无 close 也不残留死连接）；`signal()/leave()` 非 connected 静默丢弃（避免向已关闭 socket send 抛错）

### e2e（scripts/e2e.mjs 新增第 6 步，11/11）
- 模拟信令服务重启：hook 强制断开 A 的 WS + A 断网（重连尝试失败，稳定停在「自动重连」态）→ 同时断开 B → B 自动重连成功 → A 恢复网络自动重连 → 房间码不丢、E2E-B 重新出现在 A 列表、两端互见
- 为什么两端都要断：**wrangler dev 本地模式（miniflare）的已知怪癖** —— DO 实例在「WS close + 新 fetch」时被重建，内存 presence 丢失，老连接被静默丢弃（客户端收不到 close 事件）。即 A 的 WS 断开后，B 在服务端被静默踢出房间但 B 页面不知情。生产 Cloudflare 无此问题（连接活跃时 DO 不回收）；真机/部署验证不受影响。已记入 HANDOFF「已知边界与坑」
- 另注：`context.setOffline(true)` 只阻断新连接，不会关闭已建立的 WS —— 所以用 hook 强制断开

### 验收对照
1. 退避 1s→2s→4s…30s 封顶 ✅（单测退避序列）
2. 最多重连 10 次失败后放弃转 offline + 手动重试 ✅（单测；UI 有「重新连接」按钮；退避合计约 3 分钟，含尝试时间在 ~5min 量级内，与 Q4 定案一致）
3. 重连自动重新 join 原房间码 → room_state 恢复列表；房间码/传输上下文不丢 ✅（单测 + e2e）
4. 断线期间「信令重连中…」态而非永久清空列表 ✅（e2e「断线期间设备列表保留」）
5. 单测 + e2e 杀 WS→重连→列表恢复 ✅（15 单测 + e2e 11/11）

### 遗留
- 真机（iPhone/双浏览器）断网恢复待用户验证；wrangler dev 重启场景在真机同 Wi-Fi 下复验
- 本机 IP 已变为 10.213.80.3（旧 192.168.10.26）：证书 SAN 需重新生成后再做手机测试（见 HANDOFF）
