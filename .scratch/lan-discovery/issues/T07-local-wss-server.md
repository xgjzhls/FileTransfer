# T07: 电脑腿 A —— app 本地 WSS 信令服务器 + 证书

- 状态：待实现
- 阻塞：T01, T02
- 被阻塞者：T08, T09
- 引用：ADR-0009 决策 4/5；SPEC §5.6；.local-certs/（现有 CA）

## 目标
app 原生层监听 WSS（默认 8443），供桌面 Chrome 主动连入；**只转信令**（SDP/ICE），数据仍 WebRTC 直连。证书机制落地（ADR-0009 最大不确定性）。

## 验收标准（done when）
1. app 起 WSS 服务器；桌面 Chrome（PWA，https 页面）能连——无 mixed content 拦截、证书受信（先做 30 分钟 Chromium 行为 spike 定机制，再实现）
2. 证书 SAN 覆盖桌面连接地址；DHCP 换 IP 后有可行重签/重输路径（不要求零操作，要求明确可执行）
3. 服务器只转信令：抓包/ICE 日志确认文件数据不流经服务器（直连证据）
4. 桌面一次性信任 CA 脚本化：macOS `security add-trusted-cert` / Windows `certutil`（脚本放 scripts/）
5. 双平台监听（NWListener / ServerSocket）+ 桥 API；iOS 本地网络权限覆盖监听场景
6. 后台/锁屏边界文档化（前台为主）；连接数/并发边界（单桌面客户端即可）

## 备注
- 证书机制选项（ADR-0009 决策 4 注释）：a) 按 IP 重签（桌面侧脚本，IP 变则重跑）b) CA 密钥随包（app 内自签，安全权衡：CA 仅服务本用户 LAN，可接受）c) `.local` SAN + 桌面解析 `.local` 能力验证（macOS mDNSResponder 原生；Windows 需 Bonjour；Chrome 解析行为待验）——T01 spike 后 30 分钟快验 Chromium 行为再拍板
- 若证书摩擦不可接受 → 回到 ADR-0009 已接受的降级：电脑腿维持两跳 QR（app↔app 不受影响）
- WSS 端口冲突/占用处理；同一 app 多网卡（WiFi+热点）地址展示选择
