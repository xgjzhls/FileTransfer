# LocalTransfer — Context

> 本文件是项目的「共享语境」：已确立的约束、决策、开放问题、词汇表。
> 由 grill-with-docs 驱动维护；新会话先读这里。

## 一句话
零安装的局域网 P2P 文件传输：iPhone ↔ iPad ↔ 电脑（全是浏览器），传输过程无需互联网，无需任何原生应用。

## 已确立的约束（不可变）
- **不做原生应用**：iOS 不做 app（App Store 付费 + 开发版签名时限）；电脑端不做桌面 app（统一用网页）
- **数据面永远离线可用**：文件数据始终在局域网内设备间 P2P 直连，不经过任何服务器，不依赖互联网；信令面允许「在线发现（轻量信令服务）+ 离线二维码兜底」（ADR-0004）
- **局域网 P2P**：数据在两端设备间直连，不经过任何中间设备
- **电脑不必在场**：手机↔iPad 互传时只有这两台设备开机；电脑只参与涉及它的传输
- **文件规模**：单文件最大 ~10GB，支持批量多文件
- **切分/拼接对用户无感**：文件的切分与重组由系统完成，用户看到的就是一个完整文件
- **iOS ≥ 17**：目标设备系统版本；OPFS / Wake Lock / Web Share / persist() 全可用；iOS 仍无 File System Access API

## 技术选型（已定）
| 项 | 选择 | 理由 |
|---|---|---|
| 应用形态 | 单套 PWA（React + TS + Vite + vite-plugin-pwa），所有端同一套代码 | 零安装、零分发；一次引导永久离线 |
| P2P | WebRTC DataChannel（simple-peer 封装或原生） | 浏览器内唯一真 P2P 通道 |
| 信令 | 单协议双通道：在线走轻量 WebSocket 信令服务（房间发现 + SDP 中转），离线降级二维码交换压缩 SDP | 打开网页即发现设备；离线兜底（ADR-0002 / 0004） |
| 引导 bootstrap | HTTPS 静态托管（GitHub Pages / Cloudflare Pages），每设备联网访问一次 + SW 全量缓存 | 摄像头权限要求安全上下文（HTTPS）；SW 缓存后永久离线且保持安全上下文 |
| 接收端存储 | **OPFS + createSyncAccessHandle（Worker 内随机写）**（spike 验证：iOS 唯一可用写入 API；配额宽松 40GB+） | 见「关键风险」 |
| 发送端读取 | `<input type=file multiple>` + `file.slice()` 流式读 | 不把整文件载入内存 |
| 外部依赖 | 零 | 运行时全程无互联网 |

## 部署现状（T01 起）
- 托管：GitHub Pages（https://xgjzhls.github.io/FileTransfer/），**legacy 模式**（Deploy from a branch）
- 源：**main 分支**的 `/docs` 目录（提交的是构建产物）——Pages 设置需指向 main
- 流程：改代码 → `npm run build` → `rm -rf docs && mkdir docs && cp -r dist/* docs/ && rm -f docs/sw.ts && touch docs/.nojekyll` → 提交推送（Pages 自动重建）
- SW：vite-plugin-pwa injectManifest（`public/sw.ts` → dist/sw.js，预缓存全部资源 + spike 流式逻辑）
- 注意：早期试过 Actions workflow + deploy-pages，因 `github-pages` 环境的 branch_policy 拦截失败，已弃用；正式版可回归 Actions 模式（需先改环境策略）

## 架构决策记录
- [ADR-0001](decisions/adr/0001-browser-webrtc-no-native-apps.md)：浏览器 + WebRTC，零原生应用
- [ADR-0002](decisions/adr/0002-qr-signaling-no-broker.md)：纯二维码信令，无中间服务器
- [ADR-0003](decisions/adr/0003-https-bootstrap-pwa.md)：HTTPS 引导 + PWA 离线安装
- [ADR-0004](decisions/adr/0004-signaling-dual-channel.md)：信令双通道 —— 在线发现 + 离线二维码兜底
- [ADR-0005](decisions/adr/0005-resume-and-datachannel.md)：传输协议 —— bitfield 粒度续传 + ordered DataChannel
- [ADR-0006](decisions/adr/0006-symmetric-pin-discovery.md)：发现与配对 —— 对称 PIN 房间 + 离线扫码兜底
- [ADR-0007](decisions/adr/0007-offline-pairing-two-hop.md)：离线配对保持「两跳」——拒绝一扫码旁路（**完全离线是用户主场景**）

## 规格说明
- **[SPEC.md](SPEC.md)** 为传输协议、存储层、信令、UI、PWA 的正式规格（v1 定稿）。协议细节（消息 schema、状态机、续传握手、参数表）以 SPEC 为准，本文件不再重复维护草案。

## 已拍板（本会话）
- 发现机制：方案 A（在线发现 + 离线二维码兜底）→ ADR-0004
- 续传：自动续传（在线自动重连；离线重新扫码后从最后完整部分继续，不重传已收数据）→ 粒度定为 64MiB 续传块 bitfield（ADR-0005；2026-08-14 修订：传输帧 256KiB，bitfield 粒度 64MiB）
- 接收去向：「文件」App + 「照片」库（图片/小视频 <~300MB 经 Web Share 存照片；大视频/大文件存「文件」App，由用户经 Files 分享面板导入照片）
- 安全：物理在场 / 房间码在场即足够，不设额外 PIN（ADR-0006 后房间码即「对称 PIN」，语义不变）
- 发现与配对体验（ADR-0006，已接受；ADR-0007 补充）：**完全离线是用户主场景**，离线配对不是兜底而是常态。在线 = 对称 PIN 房间（输同码即自动建房/加入，无创建/加入之分；记住上次房间自动回房）；离线 = QR 两跳配对（两跳是纯浏览器物理上限——WebRTC 需双向 SDP，无法少于两次码交换，ADR-0007；打磨：自动判定角色、扫码重试、错误提示、第二跳回码体验优化）；已明确拒绝一扫码旁路（桌面信令帮手 / 音频配对，理由见 ADR-0007）；不做局域网中继，接受「纯离线无设备列表」（浏览器技术限制）
- 引导：接受「每台设备联网打开一次」（方案 A 隐含）
- DataChannel：ordered:true + reliable（v1；[v2] unordered）→ ADR-0005
- 文件夹发送（T18）：iOS Safari 18.4+ / Android Chrome 用 `webkitdirectory` 选文件夹（桌面 Chrome 维持 File System Access）；接收端导出分两种——「导出 zip（store 不压缩，保留目录结构，目标端原生解压）」与「批量分享（收进一个文件夹，子目录拍平）」，组总大小 >1GiB 守卫提示分批

## 开放问题（待拍板 / 待验证）
1. ~~接收端 10GB 存储~~ **已由 spike 验证：iOS 17+ OPFS 配额宽松（真机写到 40GB+ 未触发上限，仅受设备剩余空间约束）**，接收端存储路线定为 OPFS + createSyncAccessHandle（Worker 内同步写）。SW 流式下载方案降级为可选优化（不再必需）。
   - **存照片（spike 测试 3）**：Web Share 小文件正常；~600MB 视频调起分享时页面崩溃重载（渲染进程崩溃）→ **大视频不能可靠经 Web Share 进照片库**。设计决策：照片选项按大小阈值门控（<~300MB 走 Web Share 存照片）；大视频存「文件」App，提示用户经 Files 分享面板导入照片（原生分享可处理大文件）；Safari 与 Chrome 的边界差异待测
2. ~~电脑无摄像头时的离线 QR fallback（手动粘贴 answer 文本）~~ **已实现（T07）**：发送端与接收端均支持「手动粘贴配对码文本」替代扫码（电脑无摄像头场景；同时覆盖离线重连后的重新配对）。真机（两部 iPhone / iPhone+Mac 纯局域网）联调待验（T07 验收 6，T08 多端联调）
3. **真机验证（ADR-0006）**：对称 PIN 自动回房在 iOS Safari 独立 PWA 模式下的表现（后台恢复 / 重载后自动 join 与设备列表恢复）

## 关键风险
- ~~iOS Safari 存储配额~~ **已解除（见开放问题 #1）**；新注意点：配额随剩余空间波动，正式版传输前需容量预警
- iOS OPFS **无 createWritable**，只有 createSyncAccessHandle（须在 Worker 中用）——正式版存储层直接按此实现（已随 spike 验证）
- Safari 独立 PWA 模式（添加到主屏幕）下：下载行为、摄像头权限、分享行为与普通 tab 有差异
- 路由器 AP 隔离 / 跨 VLAN → mDNS 直连失败（需文档化 fallback；无 STUN/TURN 可用）
- 锁屏 / 后台杀连接 → Wake Lock（iOS 17+）+ 部分粒度续传缓解
- **孤儿数据**：传输/测试中断（页面被杀）会遗留 OPFS 中的部分文件且不可见 → 正式版需：会话 manifest 跟踪已收部分；启动时扫描孤儿数据并提示清理；设置页提供「清除全部数据」
- **iOS 存储分区**：iOS 上每个浏览器的网站数据独立存放（Safari / Chrome 等各一个分区），iOS 16.4+ 的独立 PWA 又是另一个分区——spike 实测：Chrome 分区里占 60GB，在 Safari 里清理看到 0。正式版需锁定数据写入与清理都在同一浏览器/模式；另外 iOS `navigator.storage.estimate()` 恒返回 0，不能依赖

## 词汇表
- **房间码**：在线信令服务中的会话标识，设备凭码加入同一房间并互相可见；ADR-0006 后即「对称 PIN」（两端输同码自动建房/加入）
- **对称 PIN**：两端输入相同 4 位房间码（32 字母表）即自动建房/加入并互见，无「创建/加入」角色之分（ADR-0006，已接受）
- **自动回房**：重开应用自动重新 join 上次房间（`lt.lastRoom` 持久化），在线时恢复设备列表；失败/离线降级扫码入口（ADR-0006，已接受）
- **presence**：设备在线状态广播，由信令服务分发给同房间设备
- **引导 bootstrap**：首次把 PWA 装到设备（联网一次，SW 缓存全部资源），之后永久离线可用
- **信令**：WebRTC 建连前的 SDP 交换；本项目用二维码完成
- **回码**：离线配对第二跳的载体——扫到对方 offer 码后生成的 answer 回执，以二维码或文本形式返回对方（ADR-0007 的打磨对象）
- **配对跳（hop）**：离线配对中一次「屏幕 → 摄像头」的单向码交换；WebRTC 需双向 SDP，纯浏览器离线至少两跳（offer 跳 + answer 跳），无法少于两跳（ADR-0007）
- **部分 part**：文件按 ~512MB 切成的存储 / 续传粒度，独立校验
- **chunk / 帧**：传输层小分块（256KiB-64，DataChannel maxMessageSize 262144 硬上限），单条 DataChannel 消息；背压粒度
- **续传块（64MiB）**：bitfield 粒度单位，1 bit = 256 帧；每 part（512MiB）8 块；崩溃最多重传 64MiB + 在途
- **spike**：验证假设的抛原型（如 10GB 配额验证页）
- **安全上下文 secure context**：浏览器授予摄像头/麦克风等权限的前提；HTTPS 或 localhost 才满足，局域网 http://IP 不满足
