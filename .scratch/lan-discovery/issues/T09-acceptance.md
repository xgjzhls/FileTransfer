# T09: 多端真机验收（离线主场景全链路）

- 状态：ready-for-human
- 阻塞：T05, T06, T07, T08
- 被阻塞者：无
- 引用：ADR-0009；SPEC §5.5/§5.6/§6/§8

## 目标
ADR-0009 全链路真机验收，确认「完全离线（无互联网）」主场景下两条腿都兑现，且既有在线路径无回归。

## 验收标准（done when）
1. iOS app ↔ iOS app 离线传（免扫码）：1GB SHA-256 一致
2. iOS app ↔ Android app 离线传（跨平台互发现）
3. iOS app ↔ 桌面 Chrome 离线传（WSS 电脑腿，免两跳）：1GB SHA-256 一致
4. 在线场景回归：自动回房（ADR-0006）/ 房间设备列表 / 在线传输不受影响
5. 可见性开关：关闭后双向不可见；重启保持；重新开启恢复
6. QR 兜底回归：AP 隔离 / 服务器不可达场景降级 QR 两跳仍可用
7. 断网中断 → 重新发现/重连 → bitfield 续传（§3.4）从断点继续
8. 文档一致性：CONTEXT.md / ADR-0009 / SPEC 与实际行为无漂移

## 备注
- 设备矩阵：iPhone（app 壳）+ Android 手机（app 壳）+ 桌面 Chrome——用户自备
- 与 .scratch/transfer T08（多端联调）的既有验证互补：本票聚焦离线新链路
- 若分支 B（原生数据面）：验收 1/2/3 全部走原生数据面，吞吐/内存按 T05 标准

---

## 验收手册（真机执行，2026-08-17 agent 编写）

> 所有验收在 **同一 Wi-Fi、无 AP 隔离** 网络下进行；「完全离线」= **路由器断外网（WAN 拔线/后台关闭）**，设备保持同 Wi-Fi（数据面本就局域网直连，断外网即模拟信令服务不可达）。
> 「应用内校验」指：传输完成且接收端逐 part SHA-256 校验全绿（`part_done` actual == expected，`src/transfer/receiver.ts`），无红色失败块。

### 0. 设备准备（一次性）
- **iPhone ×2**：`bash scripts/ios-deploy.sh`（Xcode 16+ 个人免费签名；首装后 设置 → 通用 → VPN 与设备管理 → 信任）。签名 7 天过期需重签。
- **Android 手机**（跨平台腿）：`npm run build:app && npx cap sync android && cd android && ./gradlew assembleDebug`（AGP 8.13.0 / Gradle 8.14.3 / JDK 21+；本机 Java 25 可能需降级，T03 备注）→ 数据线 `./gradlew installDebug` 或侧载 apk。Android 13+ 首次打开需授予「附近设备」权限（NEARBY_WIFI_DEVICES，T03）。
- **桌面 Chrome**（电脑腿）：先联网打开一次 GitHub Pages PWA（https://xgjzhls.github.io/FileTransfer/，bootstrap + SW 缓存），之后可断外网。
- **1GB 测试文件**：离线前在桌面生成并预存哈希：
  ```bash
  dd if=/dev/urandom of=/tmp/t09-1g.bin bs=1m count=1024
  shasum -a 256 /tmp/t09-1g.bin > /tmp/t09-1g.sha256   # 抄到纸上/手机备忘录（离线无网络）
  ```
- **iOS 端独立哈希核验**：接收端导出到「文件」App 后，用 快捷指令 →「获取文件校验和」（SHA-256）比对预存值。（app 内逐 part 校验已全绿 + 大小一致时，此为可选增强。）

### 1. iOS ↔ iOS 离线传（免扫码）— 验收 1
1. 两部 iPhone 同 Wi-Fi，路由器断外网。
2. 打开 app，首页「局域网发现」区块应互相看到对方（名称 + 类型 tag；本地网络权限弹窗点允许）。
3. 点选对方设备 → 原生信令建连 → 传输区出现。传 `/tmp/t09-1g.bin`（从另一台设备的文件输入选择）。
4. 完成后：接收端应用内校验全绿；导出到「文件」App，快捷指令 SHA-256 比对 == 预存值。
5. **反向再传一次**（换 sender；双发起双向均应可连，T05 契约）。
6. 判据：两条腿 1GB SHA-256 一致，全程零扫码、零外网。

### 2. iOS ↔ Android 离线传（跨平台互发现）— 验收 2
1. 同网络同离线。iPhone 与 Android 打开 app。
2. 判据：**互见**——iOS「局域网发现」出现 Android 设备、Android 出现 iPhone（跨平台 mDNS/DNS-SD 互操作是 T03 最大风险点，失败即阻塞 bug）。
3. 双向各传一个 ~100MB 文件：应用内校验全绿（跨平台 WebRTC 数据面）。
4. 失败时降级路径：QR 两跳仍应可用（见验收 6），并记录为阻断项。

### 3. iOS ↔ 桌面 Chrome 离线传（WSS 电脑腿）— 验收 3
1. iPhone app 首页「电脑腿连接」区块：记录地址 `wss://<ip>:9443/ws?device=<id>` 与 **CA 指纹**。
2. 桌面一次性信任 CA（重启 Chrome 生效）：
   ```bash
   bash scripts/trust-local-ca.sh https://<ip>:9443/ca.crt <CA指纹>
   ```
   （幂等；换 IP/重签叶证书无需再信任。）
3. 桌面 Chrome 打开 PWA → 「本地服务器连接的设备」区块 → 粘贴地址 → 应显示已连 + 设备卡片（先走 `GET /` 设备信息，再 WSS）。
4. 点选设备 → 桌面发 offer 经本地 WSS 转发 → app 回 answer → WebRTC 直连（信令中转、数据直连）。传 1GB：接收端校验全绿 + 快捷指令/`shasum` 比对（双向各一次）。
5. **失败路径**：未信任 CA 时 Chrome 应报证书错误（证明 WSS 生效）；信任后重连成功。
6. **重连**：断开 Wi-Fi 再连（IP 可能变）→ 桌面退避重连 ≤5 次后提示重输地址；app 端换 IP 自动重签叶证书（SAN 覆盖新 IP）。
7. 可选（Windows）：Windows Chrome + Bonjour 解析 `<deviceId>.local` 免重输（T07 待验项；无 Windows 可跳过，记录「未验」）。

### 4. 在线场景回归 — 验收 4
1. 恢复外网。两端（手机 + 桌面网页或第二手机）打开 app → 自动回房（`lt.lastRoom`）→ 「在线房间」区块恢复设备列表（ADR-0006）。
2. 在线传一个小文件：WS 信令 → WebRTC，正常（无回归）。
3. 判据：在线房间设备门控（PIN）仍生效——未输码设备不可见；「局域网发现」区块与「在线房间」并存（在线时在线房间为主）。

### 5. 可见性开关 — 验收 5
1. 设置 → 局域网可见性 → 关。
2. 双向不可见：本机不出现在对端「局域网发现」，本机也不发现对端（不广告不浏览）。
3. 杀掉 app 重开：仍是关（`lt.lanVisible` 持久化）。
4. 重新开启：对端设备重新出现在「局域网发现」，可点选连接（恢复）。
5. 判据：全程在线房间 / 扫码配对功能不受影响。

### 6. QR 兜底回归 — 验收 6
1. **AP 隔离**：路由器开客户端隔离（或换隔离 AP）→ mDNS 发现与原生信令直连失败。
2. 离线 QR 两跳应仍可用：offer 码（可点放大全屏）→ answer 码 → 建连传小文件（ADR-0007 兜底不变）。
3. 电脑无摄像头路径：手动粘贴配对码文本（T07 已实现）。
4. **服务器不可达**：断外网（同验收 1 环境）直接走扫码配对入口，不阻塞。

### 7. 断网中断 → 续传 — 验收 7
1. iOS↔iOS 传一个 ≥500MB 文件，传输中途**杀掉 sender app**（或对端开飞行模式模拟断连）。
2. 重开 app → 重新发现 → 点选重连 → 传输自动从 bitfield 断点继续（§3.4：已收 64MiB 块不重传；进度从接近断点处起跳）。
3. 完成后：应用内校验全绿；整体 SHA-256 == 预存值（续传不损坏数据）。
4. 电脑腿同法复验一次（桌面断 WSS → 重连 → 续传）。

### 记录格式
逐条记录：`验收 N：PASS / FAIL（现象 + 复现步骤）/ 未测`。FAIL 项在 `## Comments` 登记并阻塞 close；全部 PASS 后把本票状态改为 `已完成`。

---

## 文档一致性审计（验收 8，agent 已执行 2026-08-17）

对照代码逐项核对 CONTEXT.md / ADR-0009 / SPEC §5.5/§5.6 vs 实际实现：

| 声明 | 文档 | 代码证据 | 结论 |
|---|---|---|---|
| 服务类型 `_localtranfer._tcp` + TXT name/id/kind/port/ver | SPEC §5.5 / CONTEXT / ADR-0009 | `plugins/lan-discovery/src/txt.ts`（SERVICE_TYPE + TXT schema） | ✓ 无漂移 |
| app↔app 原生信令 TCP 默认 8443，被占试 8444/8445 | SPEC §5.5 | `src/lan/lanSession.ts:41` + `plugins/lan-discovery/src/index.ts` | ✓ 无漂移 |
| WSS 电脑腿默认 9443，被占试 9444/9445（与 8443 分离） | SPEC §5.6 / CONTEXT | `plugins/lan-discovery/src/index.ts:129-134`（DEFAULT_LOCAL_SERVER_PORT=9443）；iOS/Android 原生同步 | ✓ 无漂移 |
| 叶证书 SAN = `DNS:<deviceId>.local` + 当前 IP + 127.0.0.1，按启动/网络变更重签 | T07 / SPEC §5.6 / CONTEXT | `src/lan/cert.ts`（sanExtensionValue + 自动重签逻辑）、`src/lan/localServer.ts:311` | ✓ 无漂移 |
| `GET /` 与 `/ca.crt` 带 CORS 头 | T08 / SPEC §5.6 | iOS Swift:1329 / Android Java:1942 `Access-Control-Allow-Origin: *` | ✓ 无漂移 |
| 可见性开关 `lt.lanVisible` 默认开、关 = 不广告不浏览、重启保持 | SPEC §5.5/§6 / CONTEXT / ADR-0009 | `src/lan/visibility.ts` + `src/pages/Settings.tsx:166` + `src/pages/Home.tsx:285`（会话生命周期门控） | ✓ 无漂移 |
| 桌面记住 `lt.localServer`、重开自动重连、退避 ≤5 次 | SPEC §5.6 / T08 | `src/lan/localClient.ts`（LOCAL_SERVER_KEY + 重连） | ✓ 无漂移 |
| iOS `NSLocalNetworkUsageDescription` / Android `CHANGE_WIFI_MULTICAST_STATE` + `NEARBY_WIFI_DEVICES` | T02/T03 | `ios/App/App/Info.plist:7`；`plugins/lan-discovery/android/.../AndroidManifest.xml` | ✓ 无漂移 |
| ~~WSS 默认 8443~~ | **ADR-0009 决策 4（初稿）** | 实际 9443（T07 拍板端口分离） | **⚠️ 已修正**（2026-08-17：ADR 决策 4 改为「默认 9443，被占试 9444/9445」并注明与 8443 分离的来由） |

**结论**：除 ADR-0009 决策 4 端口初稿（8443 → 9443）一处漂移已修复外，文档与实现一致。SPEC §3.4 续传粒度（64MiB bitfield）/ §5.5 信令协议（hello/signal 帧、竞态消解）与 T04/T05 实现一致（单测覆盖 552/552 绿）。

## Comments

- 2026-08-17（agent）：验收手册 + 文档一致性审计落地（见上）；状态 待实现 → ready-for-human（验收 1–7 需用户真机执行）。前置验证：`npm test` 552/552 绿、`npm run build` 通过。ADR-0009 决策 4 端口漂移已修。
