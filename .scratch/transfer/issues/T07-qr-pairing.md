# T07: 离线二维码配对

- 状态：待实现
- 阻塞：T04
- 被阻塞者：T08
- 引用：SPEC §5.3；ADR-0002/0004

## 目标
无互联网/无信令服务时的配对：二维码交换压缩 SDP，建立与在线路径相同的连接（单协议双载体）。

## 验收标准（done when）
1. offer 端生成二维码（gzip+b64 的 `signal.payload`，gathering complete 后序列化），answer 端扫码解码生成 answer 二维码，offer 端再扫 → 建连
2. 扫码用 `qr-scanner`（封装 jsQR + 摄像头循环，兼容 iOS Safari 权限流）；渲染用 `qrcode`
3. 摄像头权限引导：HTTPS 源 + 首次授权（iOS 独立 PWA 也需验证）
4. 建连后完全复用 T04/T05/T06 路径（含离线断连后重新扫码续传）
5. 电脑无摄像头 fallback：手动粘贴 answer 文本（低优先级，可后置）
6. 真机测试：两部 iPhone（或 iPhone+Mac）关网/断 Wi-Fi 路由器外网，纯局域网扫码配对传输成功

## 备注
- 二维码即发现机制（无在线列表）；「谁先扫」交互需在 UI 说清
- 压缩后 SDP（host + mDNS candidates）应 <3KB（QR v40-L 容量），若超限需截断非必要 candidate（保留 host/mDNS）
