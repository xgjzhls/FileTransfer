# T10: DO presence 持久化 —— Hibernation evict 不丢房间状态

- 状态：待实现
- 阻塞：T03
- 被阻塞者：T08（部署验收 / 多端真机联调）
- 引用：SPEC §5.2；T04 已知问题 2

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
