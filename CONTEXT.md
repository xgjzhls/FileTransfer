# LocalTransfer — Context

> 本文件是项目的「共享语境」：已确立的约束、决策、开放问题、词汇表。
> 由 grill-with-docs 驱动维护；新会话先读这里。

## 一句话
零安装的局域网 P2P 文件传输：iPhone ↔ iPad ↔ 电脑（全是浏览器），传输过程无需互联网，无需任何原生应用。

## 已确立的约束（不可变）
- **不做原生应用**：iOS 不做 app（App Store 付费 + 开发版签名时限）；电脑端不做桌面 app（统一用网页）
- **必须完全离线**：传输过程零互联网依赖（无外网信令、无公共 STUN/TURN、无云托管运行时）
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
| 信令 | 二维码交换压缩 SDP（offer → answer，两次扫码） | 离线 + 无中间设备 + 浏览器不能监听端口 → 唯一可行通道 |
| 引导 bootstrap | HTTPS 静态托管（GitHub Pages / Cloudflare Pages），每设备联网访问一次 + SW 全量缓存 | 摄像头权限要求安全上下文（HTTPS）；SW 缓存后永久离线且保持安全上下文 |
| 接收端存储 | **未定** —— 待 spike：A) SW 流式下载直落「文件」App；B) OPFS + persist()（配额存疑） | 见「开放问题」 |
| 发送端读取 | `<input type=file multiple>` + `file.slice()` 流式读 | 不把整文件载入内存 |
| 外部依赖 | 零 | 运行时全程无互联网 |

## 架构决策记录
- [ADR-0001](decisions/adr/0001-browser-webrtc-no-native-apps.md)：浏览器 + WebRTC，零原生应用
- [ADR-0002](decisions/adr/0002-qr-signaling-no-broker.md)：纯二维码信令，无中间服务器
- [ADR-0003](decisions/adr/0003-https-bootstrap-pwa.md)：HTTPS 引导 + PWA 离线安装

## 传输协议设计（草案）
- **建连**：A 端生成 offer → gzip 压缩 → 二维码 → B 端扫码 → 生成 answer → 二维码 → A 扫码 → DataChannel 建立
- **元数据先行**：连接建立后先发文件清单（名/大小/校验和），接收端确认后才开始传输
- **两级分块**：文件切 ~512MB「部分」（part，存储与续传粒度）+ 传输层小 chunk（256KB–1MB，背压与重传粒度）
- **校验**：逐部分 SHA-256；缺失 chunk 重传
- **背压**：`bufferedAmount` 控制发送速率
- **续传**：中断后重新配对，从最后一个完整部分继续，已收部分保留
- **拼接**：接收端部分落盘 → 全部完成后自动拼接为单个文件 → 导出到「文件」App

## 开放问题（待拍板 / 待验证）
1. **发现机制（用户新增需求：打开网页即看到所有开启本页的设备）**——纯离线 + 无中间设备下浏览器无法自动发现（无局域网广播/监听 API），需拍板：
   - 方案 A（推荐）：互联网轻量信令服务做在线发现 + 二维码离线兜底；数据始终局域网 P2P 直连不经过服务器
   - 方案 B：严格离线，仅二维码发现（不满足「打开即见设备」）
2. **接收端 10GB 存储方案 —— 待 spike（最高优先级）**：
   - iOS Safari OPFS 实际配额（是否容得下 10GB、`navigator.storage.persist()` 是否提额）
   - 能否用 SW 流式 Response 把 DataChannel 数据直接下载进「文件」App（绕过 OPFS 配额；风险：Safari 可能整体缓冲）
3. 引导：是否接受「每台设备需联网一次」（30 秒一次性安装，之后永久离线）
4. 续传交互：中断后重新配对续传是否可接受
5. 接收端文件去向：仅「文件」App？是否也导出到「照片」库
6. 安全模型：配对即物理在场证明（二维码）或在线房间码，是否需要额外 PIN
7. 电脑无摄像头时的 fallback（手动粘贴 answer 文本）

## 关键风险
- **iOS Safari 存储配额**（历史 ~1GB/origin）：10GB 能否容纳未验证 → 最高优先级 spike，需要真实 iPhone/iPad
- Safari 独立 PWA 模式（添加到主屏幕）下：下载行为、摄像头权限、分享行为与普通 tab 有差异
- 路由器 AP 隔离 / 跨 VLAN → mDNS 直连失败（需文档化 fallback；无 STUN/TURN 可用）
- 锁屏 / 后台杀连接 → Wake Lock（iOS 17+）+ 部分粒度续传缓解

## 词汇表
- **引导 bootstrap**：首次把 PWA 装到设备（联网一次，SW 缓存全部资源），之后永久离线可用
- **信令**：WebRTC 建连前的 SDP 交换；本项目用二维码完成
- **部分 part**：文件按 ~512MB 切成的存储 / 续传粒度，独立校验
- **chunk**：传输层小分块（256KB–1MB），背压与重传粒度
- **spike**：验证假设的抛原型（如 10GB 配额验证页）
- **安全上下文 secure context**：浏览器授予摄像头/麦克风等权限的前提；HTTPS 或 localhost 才满足，局域网 http://IP 不满足
