# T01 数据面 spike —— WKWebView（Capacitor）内 WebRTC DataChannel 可用性

> 对应 ticket：`.scratch/lan-discovery/issues/T01-dataplane-spike.md`（ADR-0009 决策 3 的判据）。
> 本 spike 放在 prototype 分支，**用完即弃**（仿 `prototype/ios-app-spike`，真机实测 + 结论写回 `RESULTS.md`）。
> 完成后结论写回：分支 A（DataChannel 可用）→ 原生只管发现+信令，传输/续传/OPFS 全复用；分支 B → 原生 TCP 数据面，电脑腿顺延。

## 要回答的问题

1. Capacitor app（WKWebView，`capacitor://localhost` secure context）内 `RTCPeerConnection` + `RTCDataChannel`
   能否在局域网内建连 —— WKWebView↔WKWebView 与 WKWebView↔桌面 Chrome 各一组
2. WebKit bug 174500：仅数据通道的直连是否需要摄像头/麦克风权限；授权后是否可用；是否有可靠 workaround
3. 吞吐量级（目标 ≥ 现有 ~30 MiB/s）、峰值内存、后台/锁屏行为

## 结构

```
spike/dataplane/
├── www/                  # 自包含测试页（无构建、无依赖），两端共用同一页面
│   ├── index.html
│   └── spike.js          # 信令（复用正式协议）+ WebRTC 数据面 + 吞吐/延迟/内存/后台探针
├── ios/                  # 极简 Capacitor 壳（local.transfer.dataplane，无原生插件）
├── smoke/                # 冒烟测试（真实信令 + 假传输全链路验证页面逻辑）
├── capacitor.config.json
├── package.json
├── README.md
├── RESULTS.md            # 真机结论写回处
└── wizard.sh             # 真机运行向导（生成 results.env）
```

## 信令与协议

- **信令**：复用已部署的正式信令服务器 `wss://localtransfer-signaling.dirichray.workers.dev/ws`
  （只转发 SDP；数据面永不经过它）。协议与正式前端一致（SPEC §5.2）：URL 带 `?room=&device=`，
  `join` / `room_state` / `signal{kind:offer|answer, sdp}`，非 trickle ICE（gather 完成后整包 SDP）。
- **数据面**：`RTCPeerConnection({iceServers: []})` 局域网直连，仅 DataChannel（无媒体流）。
  控制帧走文本（JSON），数据块走二进制（64 KiB），背压阈值 8 MiB。
- **吞吐**：发送端壁钟 + 接收端首包→末包，两端各自统计；接收端检测收包间隙 >2s（后台/锁屏挂起信号）。

## 冒烟测试（页面逻辑全链路）

```bash
node smoke/smoke.mjs   # 需联网（连真实信令服务器）；复用仓库根 node_modules 的 playwright
```

两阶段：
1. **真实路径**：两个无头 Chrome 页加入同一房间 → 互相可见 → offer/answer 经真实信令服务器交换。
   ⚠ 本机有 Clash TUN（utun1500 = 198.18.0.1）时会劫持 Chromium 的 WebRTC host candidate，真实 ICE
   在本机无法直连 —— 状态停在 connecting 属预期，真实验证留给真机。
2. **假传输**（`smoke/fake-rtc.mjs`）：注入 FakeRTCPeerConnection（Node 中继模拟 DataChannel），
   验证完整数据面逻辑：建连 → 延迟 → 双向吞吐 → 字节核对（8 MiB 发送=接收）。

跑过的结论：SMOKE PASS（10 项）。真机跑完后把吞吐数字填进 `RESULTS.md`。

## 真机运行（向导）

```bash
bash wizard.sh
```

它逐段指导：装依赖+cap sync → Xcode 签名 → ⌘R 装到 iPhone → 桌面 Chrome 腿 → 跑测试矩阵 → 记录 results.env。

### 需要什么

- iPhone 真机（第一组）+ 桌面 Chrome（第二组）；若还有第二台 iPhone / iOS 模拟器可跑 WKWebView↔WKWebView
- 两端必须同一局域网（同一 Wi-Fi/网段；AP 隔离会失败——那也是结论）
- 桌面 Chrome 腿：`node smoke/serve.mjs` 起静态服务，开 `http://localhost:8080`（或局域网 IP）
- **已知环境坑**：本机 Clash TUN 会劫持 WebRTC candidate（198.18.0.1）。若桌面 Chrome 建连停在 connecting，
  临时关闭代理/TUN（或把 Clash 切到规则模式放行局域网）后再试。

### 测试矩阵（每条腿各跑一遍）

| 组合 | 冷启动（不授权） | 先授权（getUserMedia 弹窗允许） |
|---|---|---|
| WKWebView ↔ 桌面 Chrome | 记录：能否建连 + 报错原文 + 是否弹权限窗 | 记录：能否建连 + 耗时 |
| WKWebView ↔ WKWebView（如有第二台/模拟器） | 同上 | 同上 |

每个成功建连的组合再跑：延迟（ping-pong ×20）、吞吐 128 MiB（本机→对端）、内存（Xcode 内存仪表）、
后台挂起观察（传输中切后台 5 秒再回来，看对端日志是否出现「收包间隙」）。

## 结论分支（写回 RESULTS.md）

- **A = DataChannel 可用** → 原生只管发现+信令；T05 走 WebRTC，电脑腿数据面同路（现有传输/续传/OPFS 零改动）
- **B = 不可用** → app↔app 原生 TCP 数据面（T05 改道），电脑腿顺延（T07 降优先级）
