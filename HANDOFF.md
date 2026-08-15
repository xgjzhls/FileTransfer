# HANDOFF — LocalTransfer（换机交接）

> 交接时间：2026-08-13（第二次，换机到新电脑继续开发）。
> 阅读顺序：本文件 → `CONTEXT.md` → `SPEC.md` → `decisions/adr/` → `.scratch/transfer/issues/`（按依赖顺序）。

## 项目一句话
零安装的局域网 P2P 文件传输 PWA：iPhone ↔ iPad ↔ 电脑（全部为浏览器）。单文件 ≤10GB、批量、自动续传、可存「文件」App / 「照片」库。数据面离线可用，信令面在线（WS 房间）+ 离线（二维码）双通道。

## 仓库状态
- 远程：`git@github.com:xgjzhls/FileTransfer.git`（origin）
- 分支：`main`（T01-T10 代码完成，另含**文件夹发送（SPEC §6.3）**与**传输前容量预警（SPEC §4）**；267 单测 + e2e 14/14（降级））；`prototype/storage-spike`（只读参考，勿动）
- **T01-T10 代码全部完成 + 文件夹发送 + 容量预警**；**下一步：T08 真机验收（多端联调 + 照片门控实测 + 体验走查 + 文件夹发送/容量预警真机验证），验收即 v1**

## 已有产物
| 路径 | 内容 |
|---|---|
| `CONTEXT.md` / `SPEC.md` | 约束词汇 / 正式规格（v1 定稿） |
| `decisions/adr/0001-0005` | 架构决策 |
| `.scratch/transfer/issues/T01-T10` | 实现票；T01-T05 状态已更新，T09/T10 为新开修复票 |
| `src/` | 前端：`pages/`(Home/Settings/Spike/**OfflinePair**) + `qr/`(**qrCodec/qrRender/qrScan**) + `protocol/`(信令+传输消息类型) + `signaling/`(WS 客户端) + `webrtc/`(RtcPeer/ConnectionManager/sdpCodec/diagnostics) + `transfer/`(Sender/Receiver/Controller/framing/export) + `storage/`(OPFS 引擎+Worker+adapter+SessionStore+cleanup) |
| `server/` | CF Worker 信令：index(路由)+roomDo(DO)+roomCore(纯逻辑)+roomCode；`smoke.mjs` |
| `scripts/` | `e2e.mjs`（Playwright 点击测试）、`bench.mjs`（传输测速） |
| `.local-certs/` | 自签测试证书（**已入库**，新设备直接用；server.key 为测试私钥） |
| `.env.development` | dev 模式信令地址（指向本地 wrangler dev，未入库） |
| `docs/` | Pages 构建产物（main 分支 /docs，用户已设 Pages 源） |

## 当前进度与下一步
- 流程位置：grill-with-docs → SPEC → to-tickets → **实现中**（T01 ✅ T02 ✅ T03 ✅+部署 ✅ T04 ✅ T05 ✅ T09 ✅ T10 ✅ T06 ✅ T07 ✅ **T08 ✅ 代码完成**）
- **下一步：T08 真机验收（多端联调 + 照片门控阈值实测 + 体验走查），验收即 v1**
- 依赖图：T03 → T04 → T05 → T06 ✅；T04 ← T07 ✅；T05/06/07 → T08；T09 → T06（前置 ✅）；T10 → T08（部署必现 ✅）
- 待用户验证：T02 验收 6（iPhone 1GB 写入拼接）、T05 验收 6（双浏览器 1GB+ 传输 SHA-256 一致 + iPhone 真机）、T09/T10 断网恢复与线上 evict、T06 断连续传（e2e 桌面已绿，真机未验）、**T07 验收 6（两部 iPhone / iPhone+Mac 纯局域网扫码配对传输）**
- `npm test` 267/267 绿；`node scripts/e2e.mjs`（E2E_NO_PROXY=1）降级 14/14（本机 ICE 不可达时：仅 UI + 信令 + T07 SDP 交换）；全量 15/15 需 Clash 退出

## 本地测试环境（全本地，绕开 Cloudflare 网络问题）——关键
用户网络：DNS 被 Clash fake-ip 劫持（198.18.x.x），不开系统代理/TUN 无法直连 Cloudflare；**开发测试一律走本地信令**：

```bash
# 1. 本地信令（HTTPS，手机可访问；证书已在仓库 .local-certs/）
cd server
npx wrangler dev --port 8787 --ip 0.0.0.0 --local-protocol https \
  --https-key-path ../.local-certs/server.key --https-cert-path ../.local-certs/server.crt

# 2. 前端（HTTPS + 局域网监听）
cd ..
VITE_HTTPS=1 npm run dev        # https://192.168.10.26:5173（电脑/手机同 Wi-Fi 访问）
```

- `.env.development`：`VITE_SIGNALING_WSS=wss://192.168.10.26:8787/ws`（换机后若 IP 变化改这里）
  - **2026-08-14 本机 IP 已变为 10.213.80.3**，证书已重签（SAN 加入 10.213.80.3 + 198.18.0.1）；`.env.development` 现指向 `wss://10.213.80.3:8787/ws`，手机可直接用；e2e 若想免证书问题可临时改回 `wss://localhost:8787/ws`（SAN 含 localhost）
- **手机访问前需信任 ca.crt**（`ca.crt` 在仓库 .local-certs/，发给手机安装 + 完全信任；一次性）
- **手机连不上（超时/无法连接）排查见 `TROUBLESHOOTING.md`**：2026-08-14 最终实锤为**路由器 AP 隔离**（nc 双向测试：Mac→手机 80/443 均超时、路由器通；macOS 防火墙曾误判，已更正）
- 电脑浏览器访问 https://localhost:8787 点「高级→继续前往」豁免一次，或 sudo 装 CA 到系统钥匙串
- 证书 SAN：192.168.10.26 + 10.213.80.3 + 198.18.0.1 + 127.0.0.1 + localhost（**换机/换 IP 后重新生成**：openssl 命令见 `.local-certs/README.md`）

## 测试与验证
- 单测：`npm test`（Vitest，267 个，含 storage/webrtc/transfer/signaling/server/wakelock/dirPicker/**capacity**）
- **e2e 点击测试**：`E2E_NO_PROXY=1 node scripts/e2e.mjs https://localhost:5173`（创建房间→加入→发现→connected→传文件→T06 断连续传→**T07 离线 QR 配对+传输**→杀 WS 重连→无 JS 错；WebRTC 环境双页探测自动降级）
  - e2e 默认走代理 `http://127.0.0.1:7890`（Clash），**Clash 退出后必须 E2E_NO_PROXY=1**
  - headless chromium 需 WebRTC 参数（脚本内置）：`--disable-features=WebRtcHideLocalIpsWithMdns --force-webrtc-ip-handling-policy=default_public_and_private_interfaces --allow-loopback-ice`
  - **本机 Clash TUN 干扰同机 ICE 时自动降级**（仅 UI+信令+T07 SDP 交换断言）；彻底退出 Clash 后恢复全量（历史 15/15 全量通过记录）
- **测速**：`E2E_NO_PROXY=1 node scripts/bench.mjs https://localhost:5173 300`（300MiB，实测 ~30 MiB/s）
- 线上信令冒烟：`HTTPS_PROXY=http://127.0.0.1:7890 node server/smoke.mjs https://localtransfer-signaling.dirichray.workers.dev`（8/8）

## 已知边界与坑（调试必读）
- **DataChannel maxMessageSize = 262144**（Chrome/WebKit 硬上限）→ `CHUNK_SIZE = 256*1024-64`（帧头余量），**1MiB chunk 会抛错**；背压用 `bufferedamountlow` 事件（Sender.pump）
- **iOS OPFS 无 createWritable**，只用 createSyncAccessHandle（Worker 内）；`estimate()` 恒 0
- **Clash TUN/fake-ip**：utun 接口会让 WebRTC 候选变成 198.18.0.1（fake-ip），手机连不上电脑 → **彻底退出 Clash**（非仅关 TUN 模式）后候选回真实 IP；诊断：页面「诊断」区块收集本机候选 IP
- **mDNS 候选**（xxx.local）：依赖路由器组播解析，跨设备可能失败 → 电脑 Chrome 带 `--disable-features=WebRtcHideLocalIpsWithMdns` 启动可绕开
- **wrangler dev 本地模式（miniflare）DO 怪癖**：DO 实例在「WS close + 新 fetch」时被重建——内存 presence 丢失，老连接被静默丢弃（客户端收不到 close 事件）。现象：A 断线重连后 B 在服务端消失但 B 页面不知情。生产 Cloudflare 无此问题（连接活跃时 DO 不回收）。**T10 已缓解**：presence 持久化到 storage，新实例从 storage 重建，A 重连后无需 B 重连即恢复互见（e2e step 6 单端断开版验证）；但注意生产真实 evict 仍需线上验证一次（T08）
- **Playwright/macOS 13**：本机为 macOS 13.7，Playwright 已**降级到 1.57.0**（1.58+ 的 chromium 不再提供 mac13 构建，`playwright install` 报 "does not support chromium on mac13"）；勿盲目升级
- **`context.setOffline(true)` 只阻断新连接，不会关闭已建立的 WS**（e2e 杀 WS 用 `window.__ltSignaling.forceDisconnect()` 测试钩子，仅 DEV 构建暴露）
- **信令 WS URL 带 `?device=<uuid>`（T10）**：服务端 `acceptWebSocket` 用它打 Hibernation tag（evict 后重建 presence）；老客户端不带也能用（无 tag → 不跨 evict 恢复）。消息格式（SPEC §5.2）未动
- **续传（T06）**：64MiB 位图（256 帧/块）在接收端，节流 ≤2s 写 IndexedDB；发送端 meta 后等 resume_manifest 再发（只补缺失块）；DataChannel 断开自动重建并续传；「设置」页可删未完成会话。注意 e2e 断连续传用例需真 WebRTC（本机 Clash fake-ip 无同机 ICE 会降级跳过）
- **离线二维码（T07）**：`src/qr/`（qrCodec 信封 v1 + qrRender + qrScan）+ `pages/OfflinePair.tsx`；发送端生成配对码（gzip+b64 的 {v:1,kind,sdp}）→ 接收端扫码/粘贴 → 接收端显示回码 → 发送端扫码/粘贴 → 建连（完全离线，数据面复用）；配对码实测 666-671 字符（上限 2800）；摄像头需 HTTPS 安全上下文；电脑无摄像头用「手动粘贴配对码文本」（双向）。e2e 用 `window.__ltQr` 钩子（DEV 仅）读配对码文本走粘贴路径
- **e2e WebRTC 探测改为双页真实交换**：旧同页 loopback 在 Clash fake-ip TUN 下误判；双页（贴近真实双设备）探测可用时全量断言（传输/续传/QR 配对+传输），不可用降级为 UI+信令断言（含 T07 SDP 交换）
- 照片门控 <300MiB（`PHOTO_GATE_BYTES`）；导出有「下载到本机」（Blob，>2GB 慎用）与「导出（分享）」
- **Wake Lock（T08）**：`navigator.wakeLock` 仅 iOS 17+/新版 Chrome 支持；传输活跃且连接在线才持有，断连/取消即释放（避免一直常亮耗电）；iOS 切后台自动释放锁，回前台自动重取（`src/wakelock/wakeLock.ts`）；不支持时 UI 提示降级
- 孤儿数据：启动扫描 + 设置页清理（T02 已实现）

## 关键 bug 修复记录（e2e 驱动的坑，勿重蹈）
1. `waitForGatheringComplete` 曾无条件 resolve（new→gathering 事件）→ sdp 无候选连接卡 signaling；必须等 `iceGatheringState === 'complete'`
2. `RTCDataChannel.binaryType` 默认 'blob' → 必须设 'arraybuffer'，否则收到 Blob 解析失败
3. `adapter.writeChunk` 传 subarray 的整个 buffer（含帧头）→ 哈希不匹配；改为传 byteOffset/byteLength 零拷贝
4. Receiver 多 chunk 并发写盘竞态（openPart 双 writer）→ 每 part 串行队列
5. 接收端完成文件后本地 UI 不更新（file_done 只发对端）→ Receiver 本地 onFileDone 事件
6. 信令 API 缺 CORS 头 → 浏览器跨域拦截「创建房间报错」；已修（server cors() + OPTIONS）
7. meta 的 part sha256 空占位 → 接收端校验必败无限 part_reset；发送端 startSend 先算真实哈希
8. **接收端重启续传缺 file_done**（T07 全量 e2e 暴露）：快速传输在杀页面前已完成，重启后 meta 不再触发 file_done → UI 无导出。修：Receiver.doneFileIds() + Controller 补发
9. **手动重连时在途发送不续传**（T07 全量 e2e 暴露）：对端重载后旧连接仍显示 connected（ICE 失败检测延迟），点「连接」关旧 peer 但 interruptedRef 未置位 → 旧 Sender 永久停在死 dc 的 bufferedamountlow 等待。修：connectTo 检测 hasActiveSend（仅**在途**）→ 置 interrupted + abort → 新连接自动续传
10. **取消把未完成文件标「完成 ✓」**（T08 体验走查暴露）：Sender 对 `signal.aborted` 静默 return 且循环后无条件 `onFileDone` → 取消/断连后 UI 显示完成、重试时被 `status !== 'done'` 过滤、接收端永久 stuck（还占着 Wake Lock）。修：sendFile/sendPart 中止改抛 AbortError、`onFileDone` 仅整文件完成触发；UI 取消 → 重置 pending 可重试，断连中断 → 等重连续传

## 新电脑环境搭建（按序）
1. Node ≥ 22；`git clone` + `npm install`
2. GitHub SSH：`~/.ssh/config` 配 `Host github.com` + 新 key + `ProxyCommand nc -X connect -x 127.0.0.1:7890 %h %p`（用户网络 fake-ip 劫持，直连不通）
3. 测试依赖：`npx playwright install chromium`（e2e 用；**Playwright 需 1.57.x**，见「已知边界与坑」macOS 13 说明；可选 webkit 跨浏览器验证）
4. 本地测试环境按上文「本地测试环境」章节启动（证书已入库，无需重新生成；IP 变了才重新生成）
5. pi 技能流：如需要，从旧机拷 `~/.pi/agent/skills` 与 `~/.pi/agent/settings.json`
6. **TS7 陷阱**：DOM 类型缺 OPFS sync access handle，`src/spike/fs-sync-access.d.ts` 已补齐——勿删；`erasableSyntaxOnly` 禁参数属性/枚举，`verbatimModuleSyntax` 需 `import type`

## 部署与验证
- Pages legacy + `/docs`（main 分支）；更新流程：`npm run build` → `rm -rf docs && mkdir docs && cp -r dist/* docs/ && rm -f docs/sw.ts && touch docs/.nojekyll` → commit + push
- **注意**：构建 Pages 用 `.env`（线上信令 wss://localtransfer-signaling.dirichray.workers.dev/ws）；dev 用 `.env.development`（本地）——vite 按模式区分，互不干扰
- 换机后验证：`https://xgjzhls.github.io/FileTransfer/` 三页正常 + SW 离线可用

## 敏感信息
- **`.local-certs/server.key` 为自签测试私钥，已随仓库分发**（用户要求；仅局域网测试用，勿用于生产；生产另有 HTTPS 方案）
- 无其他密钥/凭据。T03 部署 Cloudflare 需 `wrangler login`（用户交互，勿写入仓库）
- 代理、SSH key、.env 等本机配置不入库

## suggested skills
- `tdd`（每张票测试先行）、`code-review`（提交前双轴）、`diagnosing-bugs`（iOS Safari 行为差异）、`wizard`（T03 类人类步骤）、`writing-for-agents`（改 AGENTS.md 时）
