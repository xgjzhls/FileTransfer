# T03: 信令服务 —— Cloudflare Workers 房间

- 状态：待实现
- 阻塞：无（需要用户提供 Cloudflare 账号——人类步骤）
- 被阻塞者：T04
- 引用：SPEC §5；ADR-0004

## 目标
互联网侧轻量信令服务：房间（短码）、presence 广播、signal 转发。纯转发不落盘，数据面永不接触。

## 验收标准（done when）
1. CF Workers + Durable Objects 实现房间：`join`（含 device 信息）/`leave`/`room_state`/`peer_joined`/`peer_left`/`signal{to,payload}`，消息格式符合 SPEC §5.2
2. 房间码：4 字符（排除 0/O、1/I 等易混淆字符），服务端生成，过期回收（如 24h 无活动删除）
3. 单房间设备上限（如 8）；重复 join 幂等（同一 deviceId 重连不重复广播）
4. 部署到 CF（免费档）；提供公开 wss URL 写进前端配置
5. 压测冒烟：两个浏览器标签连同一房间互通 signal（本地脚本或手动）

## 备注
- **人类步骤**：用户需注册/登录 Cloudflare 并创建 Worker + Durable Objects（可走 wizard 或给操作清单）
- 实现语言与项目一致（TypeScript）；独立目录 `server/`，与前端共用消息类型定义
- 前端配置：wss URL 通过环境变量注入构建
