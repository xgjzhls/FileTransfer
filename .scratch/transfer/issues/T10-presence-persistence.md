# T10: DO presence 持久化 —— Hibernation evict 不丢房间状态

- 状态：✅ 代码完成（server/src/roomDo.ts presence 持久化 + 唤醒重建；18 新单测）；验收 5 已用 miniflare 实例重建模拟 evict 验证
- 阻塞：T03
- 被阻塞者：T08（部署验收 / 多端真机联调）
- 引用：SPEC §5.2；T04 已知问题 2
- 完成备注：`npm test` 151/151；e2e 10/10（step 6 单端断开——B 不重连、presence 从 storage 恢复）；本地 smoke 8/8；详见文末「实现备注」

## 目标
Durable Object 被 evict 后唤醒时，房间 presence（`deviceId → info` 及 WS 映射）不丢。当前 `RoomCore.peers`、`deviceByWs`、`wsByDevice` 全部只在内存，DO evict（WebSocket Hibernation 允许连接保留、内存清空）后唤醒时 core 为空：新设备 join 只见自己、老设备收不到广播 / 被 "join first" 拒绝。**部署环境必现，本地 wrangler dev 不 evict 所以测不出来。**

## 验收标准（done when）
1. join/leave 时把 presence 持久化到 `ctx.storage`（`deviceId → info`；WS 映射可用 `acceptWebSocket` tags 或 storage 记录在唤醒时重建）
2. DO 唤醒（evict 后）从 storage 重建 `RoomCore.peers` / `deviceByWs` / `wsByDevice`，设备无需重新 join
3. 唤醒后 `signal` 转发、`peer_joined` 广播、`leave` 清理行为与未 evict 时一致
4. 单测覆盖：模拟「core 从 storage 重建」后 join 广播与 signal 转发正常；脏数据/持久化失败有兜底
5. 验证：模拟 evict（如 wrangler dev 重启 worker 后 presence 不丢）或部署环境真机验证一次

## 备注
- 重建钩子：DO 构造后首个 `webSocketMessage` / `alarm` 触发时从 storage 恢复
- 房间 TTL alarm 回收逻辑（24h）不变
- 不改变信令协议（SPEC §5.2 消息格式不动），纯服务端内部状态管理

## 实现备注（2026-08-14）

### 方案
- **presence 持久化**：join/重连时 `storage.put('presence:<deviceId>', PeerInfo)`；leave / 断开 / drop 时 delete。写失败捕获后继续（内存态仍有效，仅影响唤醒恢复）
- **WS 映射重建（tags）**：客户端 WS URL 改为 `?room=X&device=<uuid>`，服务端 `acceptWebSocket(server, [deviceId])` 打 tag。唤醒后 `getWebSockets(deviceId)` 按 tag 找回存活 socket → 重建 `deviceByWs` / `wsByDevice` + `RoomCore.restore()`（批量加入、不广播——其余设备列表未变）。**为什么改 URL**：Hibernation tag 必须在 accept 时设置且不可事后修改，而 join 是消息（accept 之后才到），URL 是运行时唯一可挂身份的地方；消息格式（SPEC §5.2）未动
- **重建钩子**：实例首个 `webSocketMessage` / `alarm` 时 `restoreIfNeeded()`（只建一次）；`alarm` 先重建再判空——避免 evict 唤醒后误删活跃房间
- **脏数据兜底**：presence 在但 `getWebSockets(deviceId)` 找不到对应 socket → 跳过并删除该键；`storage.list/put` 失败 → 捕获后按空房间/不持久化处理
- `RoomCore.restore(devices)`：批量加入不广播，同 id 覆盖（唤醒后重连新 socket 生效）

### 测试
- `room.test.ts` +3：restore 不广播 / join·signal·leave 与未 evict 一致、同 id 覆盖、restore 后 leave
- `roomDo.test.ts` 新 15 个（fake DurableObjectState 模拟 evict 唤醒）：join/leave 持久化与清理、唤醒后 signal 转发与 join 广播、唤醒后 leave、**evict 后首个事件是 close 也正确清理**、唤醒后同设备重连不误删 presence、restore 只建一次、脏数据（无 socket / 字段非法）清理、put/list 失败兜底、**list 失败 + alarm 不回收**、alarm 先重建不误删/空房间回收、deviceIdFromUrl

### 健壮性（code-review 后补）
- `webSocketClose` 也先 `restoreIfNeeded()`：evict 后首个事件是 close 时，leave 清理/peer_left 广播与未 evict 一致
- `alarm` 在 restore 失败时只顺延不 deleteAll（避免抹掉存活设备 presence）；restore 失败标记不重试（注释说明）
- 脏 presence 形状校验（id/name/kind 字符串），非法条目跳过并清理
- 信任边界：`tagByWs` 记录 URL tag，join 时 device.id 与 tag 不一致 → warn（功能不受影响，仅唤醒恢复不可用）；无鉴权场景（房间码即凭证），恶意客户端可伪冒任意 id，此校验为防御性记录
- SPEC §5.2「不落盘」句已修订：改为「只持久化 presence 元数据，不接触业务数据」

### 验证（验收 5）
- 本地无法真 evict，用 **miniflare 实例重建**（T09 发现的怪癖：close + 新 fetch → 新 DO 实例、内存清空、socket 保留）近似：A 断线重连后，B **未重连**即恢复在线（presence 从 storage 重建）——T09 时代此场景 A 只见空房间，T10 修复
- e2e step 6 已改为单端断开版（B 全程在线，断言「房间码不丢 + B 未断线 + 列表恢复」），10/10 绿
- 生产真实 evict 仍建议部署后真机/线上验证一次（T08 联调项）

### 验收对照
1. join/leave 持久化 + WS 映射 tags 可重建 ✅（roomDo.test 1/2）
2. 唤醒重建 core/映射，设备无需重新 join ✅（roomDo.test：B 不重连 signal 直达）
3. 唤醒后 signal/peer_joined/leave 与未 evict 一致 ✅（roomDo.test + e2e）
4. 单测覆盖重建 + 脏数据/持久化失败兜底 ✅（12 个 roomDo 单测）
5. 模拟 evict 验证 presence 不丢 ✅（miniflare 实例重建模拟 + e2e step 6；生产线上待 T08 真机验证）

### 遗留
- 部署后线上验证一次真实 evict（T08 联调）；本地 wrangler dev 不真 evict，无法覆盖
- 客户端 URL 带 `&device=`（Home.tsx / smoke.mjs）；老客户端不带该参数也能用（无 tag → 不跨 evict 恢复）
