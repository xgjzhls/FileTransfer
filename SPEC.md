# LocalTransfer — 技术规格说明书 (SPEC)

> 状态：已定稿（2026-08-13；2026-08-14 修订续传粒度，见 §3.1/§3.4）。依据：CONTEXT.md（约束/词汇）、decisions/adr/（决策）、prototype/storage-spike 分支（spike 验证结论）。
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
- **iOS app 壳（ADR-0008）**：Capacitor 8 打包同一套 Web 代码（WKWebView 承载）；app 内导出走原生文件夹选择 + 分块流式写（见 §4），网页版形态不变

## 3. 传输协议

### 3.1 参数

| 参数 | 值 | 说明 |
|---|---|---|
| part 大小 | 512 MiB（末 part 可小） | 存储/校验/「已完成」原子单位 |
| chunk 大小 | 256 KiB（末 chunk 可小） | 传输帧（单条 DataChannel 消息）；每 part ≤2048 帧。payload 上限取浏览器 DataChannel maxMessageSize（Chrome/WebKit 262144）减去帧头（13B）后的 256KiB-64 |
| 续传粒度（bitfield） | 64 MiB（= 256 帧） | 崩溃恢复原子单位；每 part 8 bit；崩溃最多重传 64MiB + 在途 |
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
                   "bitfield":"<base64, 每 part 8 bit（粒度 64MiB）>" }] }] }
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
4. 发送端计算缺失集合：补发缺失 64MiB 续传块（块内整发）；无记录 part 全发
5. part 收齐 → 接收端读回 OPFS 整体 SHA-256 校验 → `part_done`；失败 → 该 part bitfield 清空重传
6. 文件全部 part done → `file_done` → 进入导出流程
7. 接收端为权威状态：manifest + bitfield 持久化到 IndexedDB，节流 ≤2s（bitfield 粒度 64MiB → 崩溃最多重传 64MiB + 在途）
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
  - 单文件：`image/*|video/*` 且 < 300 MiB → 分享面板可「存储到照片」；大文件 → 「存储到文件」，界面提示可经 Files 分享面板导入照片（原生分享可处理大文件；spike 实测 ~600MiB 视频经 Web Share 崩溃）
  - **文件夹发送（name 含 `/`）**：接收端按顶层目录分组（`groupTopLevel`），目录组提供三种结构保持导出（`导出到文件夹…` 分桌面 FSA 与 iOS app 两实现，见各条目）：
    - **导出 zip（deflate 均衡压缩，level 6）**：整棵目录树打包为单个 zip（`zip.ts` T23 自写流式 zip 写入器——本地头+数据描述符+中央目录，fflate 流式 `Deflate`/`AsyncDeflate`（worker）+ 自带 CRC-32，ondrain/链式背压，内存恒定不整包驻留；小条目 ≤4 MiB 同步压缩避免每条目起 worker；UTF-8 文件名；单条目 ≤ 4GiB zip32 上限），分享（目标端「文件」App 选位置后原生解压；仅移动端——桌面 navigator.share 需激活尚在，压缩耗时后已失效会 NotAllowedError）或下载（桌面/无分享能力自动降级，两端一致）
    - **导出到文件夹…（桌面 Chrome/Edge）**：showDirectoryPicker 选目标目录 → 按相对路径逐段建目录写入文件树（`fsaExport.ts`，File.stream() 分块写，零驻留），无需解压即还原目录结构
    - **导出到文件夹…（iOS app 版，ADR-0008）**：app 内 `UIDocumentPickerViewController(.folder)` 选目标文件夹（一次，会话内有效）→ 保持相对路径逐段建目录 → OPFS 磁盘背书 File 的 `stream()` 分块（默认 4 MiB）经 JS↔原生桥逐块写（原生 `NSFileHandle`），**峰值内存 = 块大小**，目录树原生还原无需解压；分享面板（`@capacitor/share`）降级为次级按钮
    - **批量分享**：组内全部文件一次进分享面板（iOS 收进目标文件夹，子目录拍平；`shareNames` basename + 父目录前缀消歧；磁盘背书 File 零拷贝，T23）
    - **根目录组**：散文件发送（name 无 `/`，如文件夹根目录文件）归入「全部文件/根目录」组，同样提供批量导出（zip/导出到文件夹/批量分享）；重名条目 zip/目录导出用 `uniqueZipPaths` 追加序号
    - 导出不设大小上限（T22 移除 1 GiB 守卫）；T23 流式化：单文件/批量分享走 OPFS 磁盘背书 File（`getFile()` 零拷贝），zip 流式压缩写 OPFS exports/ 临时文件（`withOpfsTempFile`），不再整载内存——700MB 级多文件分享不再因内存爆失败
  - **多选批量导出（T20）**：接收列表已完成文件行带复选框，可跨顶层目录组勾选任意组合，勾选后提供三种批量操作（现有逐文件与分组导出全部保留）：
    - **导出选中到文件夹…（桌面 Chrome/Edge）**：showDirectoryPicker 选目标 → 保持相对路径写入（`photos/a.jpg` → 目标目录下 `photos/a.jpg`；根目录散文件放目标根），无需解压（iOS app 版同 §4「导出到文件夹…（iOS app 版）」）
    - **导出选中 zip**：跨组勾选打包为单个 zip（deflate level 6；分享/下载路由同分组 zip）
    - **批量分享选中（手机）**：shareNames 消歧，一次进分享面板（子目录拍平）
    - 新会话（meta）自动清空勾选；仅 `status === 'done'` 可勾（导出不设大小上限，T22）；路径消歧用 `disambiguateRootVsDir`——根散文件与目录首段同名时目录优先、散文件追加序号（FSA 建文件/建目录同名冲突会抛错）
- `navigator.storage.estimate()` 在 iOS 恒返回 0，不可用于容量判断（spike 实测）；传输前容量预警：桌面用 estimate（quota-usage）精确判定；iOS 降级 OPFS 写探测（步进到目标/失败点；探测封顶 2GiB 仅省时，非传输上限，超出时提示「已验证至少 X 可写」不阻断——传输中 QuotaExceededError 由 bitfield 续传兜底）

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

服务端职责：房间表（code → peers）、presence 广播、signal 转发。**只持久化 presence 元数据（deviceId → 设备信息，供 DO evict 后重建，T10）；不接触业务数据**。房间码即凭证，无密码（ADR-0004）。

### 5.3 离线（QR）

```
QR 文本 = base64url( gzip( { "v":1, "kind":"offer"|"answer", "sdp":"<sdp>" } ) )
```

要点：等 `icegatheringstatechange == complete` 再取 `pc.localDescription.sdp`（此时全部 candidate 已内嵌），gzip 压缩后单码装得下（QR v40-L ≈ 3KB）。方向：offer 端先显示二维码 → answer 端扫码 → answer 端显示二维码 → offer 端扫码 → 建连。电脑无摄像头 fallback：手动粘贴 answer 文本（低优先级）。扫码取景：扫描区为视频中心 95% 正方形（T15 修复——默认 2/3 会把充满取景框的码的定位角裁掉导致永不识别），取景框可见，提示「码完整入框、留边距」。

轻量打磨（ADR-0006）：扫码自动判定码型（offer/answer）并切换本端角色，无需先选；扫码失败自动重试与明确提示；错误文案按场景区分（权限 / 无摄像头 / 占用 / 非安全上下文）；配对成功明确反馈。不做中等/大改项（信任设备记忆、配对向导重设计）。

设备分工（T14）：离线配对按设备类型给默认主路径——电脑（默认无摄像头）主路径「显示配对码」（只出码、不扫码），手机/平板主路径「扫码」；pick 页三步引导（电脑显示 → 手机扫电脑屏幕 → 回码文本经微信/文件传输发回电脑粘贴），恰好一轮跨设备传输。两向均可手动切换：手机↔手机一台显示一台扫码；两台电脑走「显示 + 在扫码入口粘贴」。电脑端 offer 页的回码粘贴框常驻（不藏进 details）。数据流向与握手角色无关，连接后任一端均可发文件。

两跳体验打磨（ADR-0007，2026-08-15）：**完全离线是用户主场景**，两跳（offer 跳 + answer 跳）为纯浏览器物理上限（WebRTC 需双向 SDP，无第二条回传通道；拒绝桌面信令帮手 / 音频配对旁路，理由见 ADR-0007）。打磨目标 = 体感接近一扫码，条目：
- **回码全屏**：answer 端回码二维码放大至可用屏宽（约 `min(80vw, 360px)`，现为 260px），降低 offer 端回扫失败率
- **点击放大全屏**（T21）：offer/answer 二维码均可点击放大为全屏超大码（`min(88vw, 82vh)`，渲染上限 1024px 防拉伸发糊），点码外空白处或 Esc 关闭——手机扫电脑屏、电脑回扫手机屏时更容易对准
- **电脑端主次重排**：offer 页以「粘贴回码」为唯一主操作（常驻，T14 已定）；「扫码对方的回码」降为次要入口；「重新生成」收进角落——电脑默认免摄像头，主路径即粘贴，按钮与文案不喧宾夺主
- **回码一键分享**：answer 页增加「分享回码」——`navigator.share({ text })` 把回码文本分享到微信/文件传输（iOS 支持文本分享）；失败/不支持时降级为「复制配对码」
- **断线快捷重配**：断线警告旁提供「重新配对」按钮，一步回到 offer 页（保持本端角色，不重走 pick 页）；重新配对后自动从 bitfield 断点续传（§3.4）

### 5.4 房间码（对称 PIN，ADR-0006）

- 码格式：4 字符，32 字母表（排除易混淆字符 0/O、1/I），≈ 100 万组合；设备名/类型在 join 时上报
- **对称 PIN 语义**：两端输入相同码即自动建房/加入（`/ws?room=X` 对未知码自动建房），无「创建/加入」角色之分；协议消息零改动
- 客户端输入约束：仅接受字母表内字符（自动剔除 / 提示易混淆字符）、长度 4；服务端 `ROOM_CODE_RE` 校验兜底
- `POST /api/room` 保留：供「随机生成一个码」按钮使用（用户可自选码，也可让系统帮想）
- **记住上次房间**：房间码持久化 `lt.lastRoom`；重开在线时自动 join 上次房间，失败/离线降级到扫码入口；设置页「退出房间」清除该值

## 6. 应用流程（UI）

1. **首页（在线）**：PIN 输入框（输即加入，可「随机生成」）→ 同 PIN 设备列表（名称/类型/在线状态）→ 点选连接 → 传输区；记住的房间自动重入（ADR-0006），二次使用零操作
2. **首页（离线 / 信令不可用）**：显示「扫码配对」入口（轻量打磨版）；自动回房失败时降级至此
3. **配对**：在线点选设备；离线走二维码（offer→answer 两次扫码，免选角色）
4. **发送**：选文件（`<input type=file multiple>`；**选文件夹**：桌面 Chrome/Edge 走 File System Access（`showDirectoryPicker`）；iOS Safari 18.4+ / Android Chrome 走 `<input type=file webkitdirectory>`（浏览器递归返回目录树，`webkitRelativePath` 去掉首段即相对路径）；两者均不支持（如 iOS <18.4）自动降级多选文件 + 提示）→ 开始 → 每 part 进度。文件夹发送 name 为相对路径（`photos/2024/img.jpg`），接收端 OPFS 按 name 逐段重建目录
5. **接收**：`meta` 文件清单确认 → 自动接收（逐 part 进度）→ 完成 → 导出选择：单文件（照片门控 / 存文件）；文件夹发送按顶层目录分组 →「导出 zip（保留目录结构）」/「批量分享」/「导出到文件夹…」（iOS app 版主路径 = 选文件夹 → 分块流式拷贝，ADR-0008）
6. **断连**：在线自动重连续传；离线断线警告旁提供「重新配对」快捷入口（§5.3 打磨，一步回 offer 页），数据从 bitfield 断点继续
7. **设置**：设备名、会话列表（续传/删除）、退出房间（清 `lt.lastRoom`）、清除全部数据
8. **Wake Lock**（iOS 17+）：传输期间保持屏幕常亮；不可用时界面提示

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
9. **iOS app 壳（T24+，ADR-0008）**：Capacitor 脚手架 + 原生文件夹选择插件（UIDocumentPicker `.folder` + security-scoped URL）+ 分块写桥（4 MiB 背压）+ `@capacitor/share` 替换分享（**spike 已验 2026-08-16：sync handle 729MB/s、桥 177MB/s @4MiB、文件夹写入端到端通过**；JS 编码优化标 [v2]）
