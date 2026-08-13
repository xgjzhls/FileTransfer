# ADR-0001: 浏览器 + WebRTC，零原生应用

- 状态：已接受
- 日期：2024-08-13

## 背景
- iOS 不做 app：App Store 付费 + 开发版签名有时限
- 电脑端不做桌面 app：统一用网页
- 需求：局域网 P2P 文件传输，手机 ↔ iPad ↔ 电脑，单文件最大 ~10GB，支持批量

## 决策
所有端使用同一个 PWA；P2P 传输用 WebRTC DataChannel。

## 理由
- 浏览器不能监听端口 → 任何「设备当服务器」的架构（WebSocket 中继、HTTP 服务）在手机↔iPad 场景不可行
- WebSocket 方案不是 P2P，且需要中继设备（与「电脑不在场」约束冲突）
- 原生方案（Syncthing / Resilio 类）违反零应用约束
- WebRTC 是浏览器内唯一真 P2P 通道（Safari 14.3+ 支持 DataChannel）

## 后果
- 正面：零分发成本、一套代码、无签名/审核、全端对称
- 负面：受 iOS Safari 能力限制（存储配额、后台杀连接、无 File System Access API）；大文件存储为主要风险（见开放问题 #1）
