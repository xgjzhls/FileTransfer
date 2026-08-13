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

## 架构决策记录
- [ADR-0001](decisions/adr/0001-browser-webrtc-no-native-apps.md)：浏览器 + WebRTC，零原生应用
- [ADR-0002](decisions/adr/0002-qr-signaling-no-broker.md)：纯二维码信令，无中间服务器
- [ADR-0003](decisions/adr/0003-https-bootstrap-pwa.md)：HTTPS 引导 + PWA 离线安装
- [ADR-0004](decisions/adr/0004-signaling-dual-channel.md)：信令双通道 —— 在线发现 + 离线二维码兜底
- [ADR-0005](decisions/adr/0005-resume-and-datachannel.md)：传输协议 —— bitfield 粒度续传 + ordered DataChannel

## 规格说明
- **[SPEC.md](SPEC.md)** 为传输协议、存储层、信令、UI、PWA 的正式规格（v1 定稿）。协议细节（消息 schema、状态机、续传握手、参数表）以 SPEC 为准，本文件不再重复维护草案。

## 已拍板（本会话）
- 发现机制：方案 A（在线发现 + 离线二维码兜底）→ ADR-0004
- 续传：自动续传（在线自动重连；离线重新扫码后从最后完整部分继续，不重传已收数据）→ 粒度定为 chunk bitfield（ADR-0005）
- 接收去向：「文件」App + 「照片」库（图片/小视频 <~300MB 经 Web Share 存照片；大视频/大文件存「文件」App，由用户经 Files 分享面板导入照片）
- 安全：物理在场 / 房间码在场即足够，不设 PIN
- 引导：接受「每台设备联网打开一次」（方案 A 隐含）
- DataChannel：ordered:true + reliable（v1；[v2] unordered）→ ADR-0005

## 开放问题（待拍板 / 待验证）
1. **接收端 10GB 存储与去向 —— 待 spike（最高优先级，需真实 iPhone/iPad）**：
   - iOS Safari OPFS 实际配额（是否容得下 10GB、`navigator.storage.persist()` 是否提额）
   - SW 流式 Response 直接下载进「文件」App 是否可行（绕过 OPFS 配额；风险：Safari 可能整体缓冲）
   - Web Share 将 10GB 视频存入「照片」库是否可行
2. 电脑无摄像头时的离线 QR fallback（手动粘贴 answer 文本）—— 仅影响离线路径，低优先级

## 关键风险
- **iOS Safari 存储配额**（历史 ~1GB/origin）：10GB 能否容纳未验证 → 最高优先级 spike，需要真实 iPhone/iPad
- Safari 独立 PWA 模式（添加到主屏幕）下：下载行为、摄像头权限、分享行为与普通 tab 有差异
- 路由器 AP 隔离 / 跨 VLAN → mDNS 直连失败（需文档化 fallback；无 STUN/TURN 可用）
- 锁屏 / 后台杀连接 → Wake Lock（iOS 17+）+ 部分粒度续传缓解

## 词汇表
- **房间码**：在线信令服务中的会话标识，设备凭码加入同一房间并互相可见
- **presence**：设备在线状态广播，由信令服务分发给同房间设备
- **引导 bootstrap**：首次把 PWA 装到设备（联网一次，SW 缓存全部资源），之后永久离线可用
- **信令**：WebRTC 建连前的 SDP 交换；本项目用二维码完成
- **部分 part**：文件按 ~512MB 切成的存储 / 续传粒度，独立校验
- **chunk**：传输层小分块（256KB–1MB），背压与重传粒度
- **spike**：验证假设的抛原型（如 10GB 配额验证页）
- **安全上下文 secure context**：浏览器授予摄像头/麦克风等权限的前提；HTTPS 或 localhost 才满足，局域网 http://IP 不满足
