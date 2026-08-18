# T01: 数据面 spike —— WKWebView（Capacitor）内 WebRTC DataChannel 可用性

- 状态：待实现（实现前先跑；需用户真机）
- 阻塞：无
- 被阻塞者：T05, T07
- 引用：ADR-0009 决策 3；WebKit bug 174500；prototype/ios-app-spike 先例

## 目标
验证 app 壳内数据面能否复用现有 WebRTC 栈（原生层只管发现+信令）。这是 ADR-0009 数据面分支的判据。

## 验收标准（done when）
1. Capacitor app（WKWebView，`capacitor://localhost` secure context）内 RTCPeerConnection + RTCDataChannel 能否在局域网内建连（WKWebView↔WKWebView 与 WKWebView↔桌面 Chrome 各一组）
2. 复现/绕过 WebKit bug 174500：仅数据通道的直连是否需要摄像头/麦克风权限；请求权限后是否可用；是否有可靠 workaround
3. 吞吐量级：≥ 现有 ~30 MiB/s 量级？峰值内存？后台/锁屏行为？
4. 输出结论分支：**A = DataChannel 可用** → 原生只管发现+信令，传输/续传/OPFS 全复用（T05 走 WebRTC，电脑端数据面同路）；**B = 不可用** → app↔app 原生 TCP 数据面（T05 改道），电脑端顺延（T07 降优先级）

## 备注
- spike 放 prototype 分支（仿 prototype/ios-app-spike：真机实测 + 结论写回）
- 需设备：iPhone 真机 + 桌面 Chrome（用户自备）
- 若分支 B：原生数据面 = 原生 TCP + OPFS 写桥（对齐 folder-export 桥模式，峰值内存 = 块大小），传输协议（bitfield 续传/分块/framing）需原生或桥接重写——工作量显著，故 T07 顺延
