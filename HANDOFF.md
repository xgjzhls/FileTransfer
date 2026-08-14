# HANDOFF — LocalTransfer（换机交接）

> 交接时间：2026-08-13（第二次，换机到新电脑继续开发）。
> 阅读顺序：本文件 → `CONTEXT.md` → `SPEC.md` → `decisions/adr/` → `.scratch/transfer/issues/`（按依赖顺序）。

## 项目一句话
零安装的局域网 P2P 文件传输 PWA：iPhone ↔ iPad ↔ 电脑（全部为浏览器）。单文件 ≤10GB、批量、自动续传、可存「文件」App / 「照片」库。数据面离线可用，信令面在线（WS 房间）+ 离线（二维码）双通道。

## 仓库状态
- 远程：`git@github.com:xgjzhls/FileTransfer.git`（origin）
- 分支：`main`（工作区含 T09 未提交改动）；`prototype/storage-spike`（只读参考，勿动）
- **T01-T05 代码全部完成，T09（信令 WS 自动重连）代码完成**（15 单测 + e2e 11/11 绿）；**下一步 T10（DO presence 持久化）或 T06（续传，依赖 T09 已就绪）**

## 已有产物
| 路径 | 内容 |
|---|---|
| `CONTEXT.md` / `SPEC.md` | 约束词汇 / 正式规格（v1 定稿） |
| `decisions/adr/0001-0005` | 架构决策 |
| `.scratch/transfer/issues/T01-T10` | 实现票；T01-T05 状态已更新，T09/T10 为新开修复票 |
| `src/` | 前端：`pages/`(Home/Settings/Spike) + `protocol/`(信令+传输消息类型) + `signaling/`(WS 客户端) + `webrtc/`(RtcPeer/ConnectionManager/sdpCodec/diagnostics) + `transfer/`(Sender/Receiver/Controller/framing/export) + `storage/`(OPFS 引擎+Worker+adapter+SessionStore+cleanup) |
| `server/` | CF Worker 信令：index(路由)+roomDo(DO)+roomCore(纯逻辑)+roomCode；`smoke.mjs` |
| `scripts/` | `e2e.mjs`（Playwright 点击测试）、`bench.mjs`（传输测速） |
| `.local-certs/` | 自签测试证书（**已入库**，新设备直接用；server.key 为测试私钥） |
| `.env.development` | dev 模式信令地址（指向本地 wrangler dev，未入库） |
| `docs/` | Pages 构建产物（main 分支 /docs，用户已设 Pages 源） |

## 当前进度与下一步
- 流程位置：grill-with-docs → SPEC → to-tickets → **实现中**（T01 ✅ T02 ✅ T03 ✅+部署 ✅ T04 ✅ T05 ✅ **T09 ✅**）
- **下一步：T10（DO presence 持久化，部署必现，T08 前置）→ 然后 T06 续传**（T06 验收 4 依赖的 T09 WS 重连已就绪）
- 依赖图：T03 → T04 → T05 → T06；T04 ← T07；T05/06/07 → T08；T09 → T06（前置 ✅）；T10 → T08（部署必现）
- 待用户验证：T02 验收 6（iPhone 1GB 写入拼接）、T05 验收 6（双浏览器 1GB+ 传输 SHA-256 一致 + iPhone 真机）、**T09 真机断网恢复** —— 桌面 e2e 已全绿，真机未验
- `npm test` 133/133 绿；`node scripts/e2e.mjs`（E2E_NO_PROXY=1）11/11 绿（含 T09 杀 WS→重连→列表恢复）

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
- 单测：`npm test`（Vitest，130 个，含 storage/webrtc/transfer/signaling/server）
- **e2e 点击测试**：`E2E_NO_PROXY=1 node scripts/e2e.mjs https://localhost:5173`（创建房间→加入→发现→connected→传文件→无 JS 错；WebRTC 环境自动探测降级）
  - e2e 默认走代理 `http://127.0.0.1:7890`（Clash），**Clash 退出后必须 E2E_NO_PROXY=1**
  - headless chromium 需 WebRTC 参数（脚本内置）：`--disable-features=WebRtcHideLocalIpsWithMdns --force-webrtc-ip-handling-policy=default_public_and_private_interfaces --allow-loopback-ice`
- **测速**：`E2E_NO_PROXY=1 node scripts/bench.mjs https://localhost:5173 300`（300MiB，实测 ~30 MiB/s）
- 线上信令冒烟：`HTTPS_PROXY=http://127.0.0.1:7890 node server/smoke.mjs https://localtransfer-signaling.dirichray.workers.dev`（8/8）

## 已知边界与坑（调试必读）
- **DataChannel maxMessageSize = 262144**（Chrome/WebKit 硬上限）→ `CHUNK_SIZE = 256*1024-64`（帧头余量），**1MiB chunk 会抛错**；背压用 `bufferedamountlow` 事件（Sender.pump）
- **iOS OPFS 无 createWritable**，只用 createSyncAccessHandle（Worker 内）；`estimate()` 恒 0
- **Clash TUN/fake-ip**：utun 接口会让 WebRTC 候选变成 198.18.0.1（fake-ip），手机连不上电脑 → **彻底退出 Clash**（非仅关 TUN 模式）后候选回真实 IP；诊断：页面「诊断」区块收集本机候选 IP
- **mDNS 候选**（xxx.local）：依赖路由器组播解析，跨设备可能失败 → 电脑 Chrome 带 `--disable-features=WebRtcHideLocalIpsWithMdns` 启动可绕开
- **wrangler dev 本地模式（miniflare）DO 怪癖**：DO 实例在「WS close + 新 fetch」时被重建——内存 presence 丢失，老连接被静默丢弃（客户端收不到 close 事件）。现象：A 断线重连后 B 在服务端消失但 B 页面不知情。生产 Cloudflare 无此问题（连接活跃时 DO 不回收）。影响：本地 e2e 测 T09 重连需两端都断（脚本已如此处理）；T10 的 presence 持久化亦覆盖此场景
- **Playwright/macOS 13**：本机为 macOS 13.7，Playwright 已**降级到 1.57.0**（1.58+ 的 chromium 不再提供 mac13 构建，`playwright install` 报 "does not support chromium on mac13"）；勿盲目升级
- **`context.setOffline(true)` 只阻断新连接，不会关闭已建立的 WS**（e2e 杀 WS 用 `window.__ltSignaling.forceDisconnect()` 测试钩子，仅 DEV 构建暴露）
- 照片门控 <300MiB（`PHOTO_GATE_BYTES`）；导出有「下载到本机」（Blob，>2GB 慎用）与「导出（分享）」
- 孤儿数据：启动扫描 + 设置页清理（T02 已实现）

## 关键 bug 修复记录（e2e 驱动的坑，勿重蹈）
1. `waitForGatheringComplete` 曾无条件 resolve（new→gathering 事件）→ sdp 无候选连接卡 signaling；必须等 `iceGatheringState === 'complete'`
2. `RTCDataChannel.binaryType` 默认 'blob' → 必须设 'arraybuffer'，否则收到 Blob 解析失败
3. `adapter.writeChunk` 传 subarray 的整个 buffer（含帧头）→ 哈希不匹配；改为传 byteOffset/byteLength 零拷贝
4. Receiver 多 chunk 并发写盘竞态（openPart 双 writer）→ 每 part 串行队列
5. 接收端完成文件后本地 UI 不更新（file_done 只发对端）→ Receiver 本地 onFileDone 事件
6. 信令 API 缺 CORS 头 → 浏览器跨域拦截「创建房间报错」；已修（server cors() + OPTIONS）
7. meta 的 part sha256 空占位 → 接收端校验必败无限 part_reset；发送端 startSend 先算真实哈希

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
