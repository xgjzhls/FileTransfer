# T01 数据面 spike —— 结论

> 状态：⏳ 待真机验证（iPhone 真机 + 桌面 Chrome；wizard.sh 跑完把结果填进来）
> 日期：——
> 设备：——

## 判据：分支 A（DataChannel 可用） vs 分支 B（不可用）

| 验收项 | 结果 | 备注 |
|---|---|---|
| 1a. WKWebView↔Chrome 建连（冷启动，不授权） | ? | 报错原文 / 是否自动弹权限窗 |
| 1b. WKWebView↔Chrome 建连（先授权） | ? | 建连耗时 |
| 1c. WKWebView↔WKWebView 建连（冷启动） | ? | 同 1a |
| 1d. WKWebView↔WKWebView 建连（先授权） | ? | 同 1b |
| 2. bug 174500 结论 | ? | 仅数据通道是否必须摄像头/麦克风权限；授权后可用性；workaround 是否可靠 |
| 3a. 吞吐（发送端 / 接收端 MB/s） | ? | 目标 ≥ ~30 MiB/s |
| 3b. 峰值内存（Xcode 内存仪表 / Chrome） | ? | |
| 3c. 后台/锁屏行为 | ? | 是否出现收包间隙 / 是否继续传输 |

## 结论

**分支：A / B（待定）**

- 一句话结论：
- 对 T05（app↔app 数据面）的影响：
- 对 T07（电脑腿）的影响：

## 原始数据（wizard 的 results.env + 页面日志）

```
（贴 results.env 内容）
```

## 备注 / 环境

- iOS 版本、iPhone 型号：
- 桌面 Chrome 版本：
- 局域网情况（同一 Wi-Fi？AP 隔离？代理/TUN 是否开启）：
- 复现/绕过 bug 174500 的细节（弹窗出现时机、报错文案、workaround 步骤）：
