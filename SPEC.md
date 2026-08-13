# LocalTransfer — 技术规格说明书 (SPEC)

> 状态：已定稿（2026-08-13）。依据：CONTEXT.md（约束/词汇）、decisions/adr/（决策）、prototype/storage-spike 分支（spike 验证结论）。
> 范围：v1（可用优先；性能优化项标注 [v2]）。

## 1. 目标与非目标

**目标**：零安装的局域网 P2P 文件传输，iPhone ↔ iPad ↔ 电脑（全部为浏览器/PWA）。单文件 ≤10GB、批量传输、自动续传、图片/小视频可存照片、大文件存「文件」App。数据面离线可用，信令面在线/离线双通道。

**非目标（v1）**：跨子网/WAN 传输（无 TURN）、明文传输优化（WebRTC 自带 DTLS）、多设备同时向一台设备并发传输、[v2] unordered DataChannel。

## 2. 架构总览

- **应用**：单套 PWA（React + TS + Vite + vite-plugin-pwa），所有端同一代码
- **P2P**：WebRTC DataChannel，`ordered:true` + reliable（决策 D2）
- **信令**：单协议双载体 —— 在线 WS 房间（发现+转发）/ 离线二维码（压缩 SDP）
- **信令服务**：Cloudflare Workers + Durable Objects（免费档），纯转发不落盘
- **接收端存储**：OPFS + `createSyncAccessHandle`（Worker 内随机写）——spike 验证 iOS 唯一可用写入 API
- **托管**：GitHub Pages（当前 legacy + `/docs`，见 CONTEXT.md「部署现状」）

## 3. 传输协议

### 3.1 参数

| 参数 | 值 | 说明 |
|---|---|---|
| part 大小 | 512 MiB（末 part 可小） | 存储/校验/「已完成」原子单位 |
| chunk 大小 | 256 KiB（末 chunk 可小） | 传输单位；每 part ≤2048 chunk。payload 上限取浏览器 DataChannel maxMessageSize（Chrome/WebKit 262144）减去帧头（13B）后的 256KiB-64；CONTEXT 词汇表允许 256KB–1MB |
| part 校验 | SHA-256 | part 收齐后读回整文件校验 |
| DataChannel | ordered:true, reliable | [v2] unordered + 应用层重传 |
| 背压阈值 | bufferedAmount > 8 MiB 暂停排程 | 发送端节流 |

### 3.2 通道内消息（framing：首字节 type）

- `0x00` JSON 控制消息（UTF-8）
- `0x01` chunk 数据：`fileId u32 | partIndex u32 | chunkIndex u32 | payload(≤1MiB)`

JSON 控制消息 schema：

```jsonc
meta           { "type":"meta", "sessionId":"<uuid>", "files":[{
                   "id": 0, "name":"a.mov", "size": 10737418240,
                   "parts":[{ "index":0, "size":536870912, "sha256":"<hex>" }] }] }
resume_manifest{ "type":"resume_manifest", "files":[{
                   "id": 0, "parts":[{ "index":0, "state":"done" | "partial",
                   "bitfield":"<base64, 每 part 512bit>" }] }] }
part_done      { "type":"part_done", "fileId":0, "partIndex":0, "sha256":"<hex>" }
file_done      { "type":"file_done", "fileId":0 }
bye | error | cancel   { "type":"...", "reason"?: "..." }
```

### 3.3 连接状态机（每对端）

```
idle → signaling → connecting → connected → transferring ⇄ disconnected
disconnected → 在线：自动重连 WS → 重新 signal → 新 DataChannel（自动续传）
             → 离线：提示重新扫码配对 → 新 DataChannel
```

### 3.4 续传握手（决策 D1：bitfield 粒度）

1. 新 DataChannel 建立
2. 发送端发 `meta`（sessionId + 完整文件/part 清单）
3. 接收端回 `resume_manifest`：`done` 的 part 直接跳过；`partial` 的 part 附 bitfield
4. 发送端计算缺失集合：补发缺失 chunk；无记录 part 全发
5. part 收齐 → 接收端读回 OPFS 整体 SHA-256 校验 → `part_done`；失败 → 该 part bitfield 清空重传
6. 文件全部 part done → `file_done` → 进入导出流程
7. 接收端为权威状态：manifest + bitfield 持久化到 IndexedDB，节奏 ≤2s 或每 32 chunk（崩溃最多重传 32 MiB）
8. 发送端页面重载后：重新选文件 → 按 `name + size` 与 manifest 匹配 → 继续（File 对象易失，不持久化）

### 3.5 发送顺序与进度

- 文件按队列顺序处理（一次一个文件），文件内 part 顺序，part 内按 chunkIndex 顺序
- 发送端以 localStorage 缓存「每文件已完成 part 数」用于重载后的进度显示（非权威，可丢）

## 4. 接收端存储层

- **OPFS 布局**：
  - `sessions/<sessionId>/<fileId>/part-<index>.bin`（接收中的 part）
  - 完成拼接：`sessions/<sessionId>/<fileId>/<name>`（part 顺序拷贝合并）
- **写入**：Worker 内 `createSyncAccessHandle().write(buf, { at: offset })`；接收线程 postMessage 逐 chunk 递给 worker
- **manifest**：IndexedDB（含节流 bitfield）
- **孤儿数据**：启动扫描 `sessions/`：无 manifest 或超期（30 天）→ 提示清理；设置页「清除全部数据」一键删除 OPFS + IndexedDB
- **分区**：iOS 各浏览器/独立 PWA 存储分区隔离 —— 数据写入与清理必须同一浏览器/模式（spike 实测）
- **导出**：完成后拼接 → `navigator.share({ files })`：
  - `image/*|video/*` 且 < 300 MiB → 分享面板可「存储到照片」
  - 大文件 → 「存储到文件」，界面提示可经 Files 分享面板导入照片（原生分享可处理大文件；spike 实测 ~600MiB 视频经 Web Share 崩溃）
- `navigator.storage.estimate()` 在 iOS 恒返回 0，不可用于容量判断（spike 实测）；传输前容量预警暂以设备剩余空间估算（[v2]）

## 5. 信令

### 5.1 原则：单协议双载体

同一个 `signal.payload` 结构，WS 与 QR 共用 —— WebRTC 连接层一套代码。

### 5.2 在线（WS 房间）

```jsonc
→ join        { "type":"join", "room":"K7Q2", "device":{ "id":"<uuid>", "name":"iPhone", "kind":"phone" } }
← room_state  { "type":"room_state", "peers":[{ "id", "name", "kind" }] }      // 发给加入者
← peer_joined { "type":"peer_joined", "peer":{...} }                           // 广播给同房间其他人
← peer_left   { "type":"peer_left", "peerId":"<uuid>" }
→ leave       { "type":"leave" }
→ signal      { "type":"signal", "to":"<peerId>", "payload":{ "kind":"offer"|"answer", "sdp":"<gzip+b64>" } }
```

服务端职责：房间表（code → peers）、presence 广播、signal 转发。**不落盘、不接触业务数据**。房间码即凭证，无密码（ADR-0004）。

### 5.3 离线（QR）

```
QR 文本 = base64url( gzip( { "v":1, "kind":"offer"|"answer", "sdp":"<sdp>" } ) )
```

要点：等 `icegatheringstatechange == complete` 再取 `pc.localDescription.sdp`（此时全部 candidate 已内嵌），gzip 压缩后单码装得下（QR v40-L ≈ 3KB）。方向：offer 端先显示二维码 → answer 端扫码 → answer 端显示二维码 → offer 端扫码 → 建连。电脑无摄像头 fallback：手动粘贴 answer 文本（低优先级）。

### 5.4 房间码

服务端生成 4 字符码（排除易混淆字符，如 0/O、1/I）。加入者输码入房；设备名/类型在 join 时上报。

## 6. 应用流程（UI）

1. **首页**：连信令 → 显示本房间码 + 同房间设备列表（在线）；无网时显示「扫码配对」入口
2. **配对**：在线点选设备；离线走二维码（offer→answer 两次扫码）
3. **发送**：选文件（`<input type=file multiple>`；桌面 Chrome 用 File System Access 选文件夹）→ 开始 → 每 part 进度
4. **接收**：`meta` 文件清单确认 → 自动接收（逐 part 进度）→ 完成 → 导出选择（照片门控 / 存文件）
5. **断连**：在线自动重连续传；离线提示重新扫码（数据从 bitfield 继续）
6. **设置**：设备名、会话列表（续传/删除）、清除全部数据
7. **Wake Lock**（iOS 17+）：传输期间保持屏幕常亮；不可用时界面提示

## 7. PWA 引导

- HTTPS 静态托管（现 GitHub Pages）；SW 全量预缓存（vite-plugin-pwa）→ 离线可用
- 添加到主屏幕；摄像头权限在引导时授予（ADR-0003）
- 首次打开需联网一次（ADR-0003/0004）

## 8. 里程碑（tickets 见 to-tickets）

按依赖排序的垂直切片：

1. **骨架**：React+Vite+PWA+SW 预缓存+Pages 部署（含本地 spike 页迁移）
2. **存储层**：OPFS worker（sync handle 随机写/读）+ manifest + 孤儿清理 + 设置页
3. **信令服务**：CF Workers + DO 房间（join/leave/presence/signal 转发）
4. **WebRTC 连接（tracer bullet）**：WS 发现 → signal → DataChannel → meta 握手（垂直打通）
5. **chunk 传输**：分块收发 + 背压 + part 校验 + part_done/file_done + 导出
6. **续传**：bitfield 持久化 + resume_manifest 握手 + 自动重连（在线）
7. **离线 QR**：压缩 SDP + 两次扫码配对 + 离线续传
8. **收尾**：照片门控、批量队列 UI、Wake Lock、孤儿清理集成、多端真机联调
