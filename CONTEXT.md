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
| 接收端存储 | **未定** —— 待 spike：A) SW 流式下载直落「文件」App；B) OPFS + persist()（配额存疑） | 见「开放问题」 |
| 发送端读取 | `<input type=file multiple>` + `file.slice()` 流式读 | 不把整文件载入内存 |
| 外部依赖 | 零 | 运行时全程无互联网 |

## 部署现状（spike 阶段）
- 托管：GitHub Pages（https://xgjzhls.github.io/FileTransfer/），**legacy 模式**（Deploy from a branch）
- 源：`prototype/storage-spike` 分支的 `/docs` 目录（提交的是构建产物）
- 流程：改代码 → `npm run build` → `rm -rf docs && mkdir docs && cp -r dist/* docs/ && touch docs/.nojekyll` → 提交推送（Pages 自动重建）
- 注意：早期试过 Actions workflow + deploy-pages，因 `github-pages` 环境的 branch_policy 拦截失败，已弃用并删除该工作流；后期正式版可回归 Actions 模式

## 架构决策记录
- [ADR-0001](decisions/adr/0001-browser-webrtc-no-native-apps.md)：浏览器 + WebRTC，零原生应用
- [ADR-0002](decisions/adr/0002-qr-signaling-no-broker.md)：纯二维码信令，无中间服务器
- [ADR-0003](decisions/adr/0003-https-bootstrap-pwa.md)：HTTPS 引导 + PWA 离线安装
- [ADR-0004](decisions/adr/0004-signaling-dual-channel.md)：信令双通道 —— 在线发现 + 离线二维码兜底

## 传输协议设计（草案）
- **建连**：A 端生成 offer → gzip 压缩 → 二维码 → B 端扫码 → 生成 answer → 二维码 → A 扫码 → DataChannel 建立
- **元数据先行**：连接建立后先发文件清单（名/大小/校验和），接收端确认后才开始传输
- **两级分块**：文件切 ~512MB「部分」（part，存储与续传粒度）+ 传输层小 chunk（256KB–1MB，背压与重传粒度）
- **校验**：逐部分 SHA-256；缺失 chunk 重传
- **背压**：`bufferedAmount` 控制发送速率
- **自动续传**：中断后在线自动重连（或离线重新扫码配对），两端交换会话清单（manifest），接收端已收完整部分直接跳过，只补缺失部分
- **拼接**：接收端部分落盘 → 全部完成后自动拼接为单个文件 → 导出到「文件」App

## 已拍板（本会话）
- 发现机制：方案 A（在线发现 + 离线二维码兜底）→ ADR-0004
- 续传：自动续传（在线自动重连；离线重新扫码后从最后完整部分继续，不重传已收数据）
- 接收去向：「文件」App + 「照片」库（图片/视频经 Web Share 存照片，其余存文件）
- 安全：物理在场 / 房间码在场即足够，不设 PIN
- 引导：接受「每台设备联网打开一次」（方案 A 隐含）

## 开放问题（待拍板 / 待验证）
1. ~~接收端 10GB 存储~~ **已由 spike 验证：iOS 17+ OPFS 配额宽松（真机写到 40GB+ 未触发上限，仅受设备剩余空间约束）**，接收端存储路线定为 OPFS + createSyncAccessHandle（Worker 内同步写）。SW 流式下载方案降级为可选优化（不再必需）。
   - 待补：Web Share 将大视频存入「照片」库是否可行（测试 3，存照片是已定需求）
2. 电脑无摄像头时的离线 QR fallback（手动粘贴 answer 文本）—— 仅影响离线路径，低优先级

## 关键风险
- ~~iOS Safari 存储配额~~ **已解除（见开放问题 #1）**；新注意点：配额随剩余空间波动，正式版传输前需查 `navigator.storage.estimate()` 预警
- iOS OPFS **无 createWritable**，只有 createSyncAccessHandle（须在 Worker 中用）——正式版存储层直接按此实现（已随 spike 验证）
- Safari 独立 PWA 模式（添加到主屏幕）下：下载行为、摄像头权限、分享行为与普通 tab 有差异
- 路由器 AP 隔离 / 跨 VLAN → mDNS 直连失败（需文档化 fallback；无 STUN/TURN 可用）
- 锁屏 / 后台杀连接 → Wake Lock（iOS 17+）+ 部分粒度续传缓解
- **孤儿数据**：传输/测试中断（页面被杀）会遗留 OPFS 中的部分文件且不可见 → 正式版需：会话 manifest 跟踪已收部分；启动时扫描孤儿数据并提示清理；设置页提供「清除全部数据」

## 词汇表
- **房间码**：在线信令服务中的会话标识，设备凭码加入同一房间并互相可见
- **presence**：设备在线状态广播，由信令服务分发给同房间设备
- **引导 bootstrap**：首次把 PWA 装到设备（联网一次，SW 缓存全部资源），之后永久离线可用
- **信令**：WebRTC 建连前的 SDP 交换；本项目用二维码完成
- **部分 part**：文件按 ~512MB 切成的存储 / 续传粒度，独立校验
- **chunk**：传输层小分块（256KB–1MB），背压与重传粒度
- **spike**：验证假设的抛原型（如 10GB 配额验证页）
- **安全上下文 secure context**：浏览器授予摄像头/麦克风等权限的前提；HTTPS 或 localhost 才满足，局域网 http://IP 不满足
