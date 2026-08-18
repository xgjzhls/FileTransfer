# T07: 电脑端 A —— app 本地 WSS 信令服务器 + 证书

- 状态：✅ 代码完成（2026-08-17：spike 定机制 + cert.ts WebCrypto 自签（DER/X509 手工构建，Node/OpenSSL oracle 15 测试）+ 桥 API（startLocalServer/stopLocalServer/sendLocalMessage/getLocalAddresses + 3 事件，facade 校验 8 测试）+ iOS 原生 WSS（NWListener TLS + HTTP 升级 + RFC 6455 帧 + 单客户端，Swift stub 编译零告警）+ Android 原生 WSS（SSLServerSocket + 自定义 X509KeyManager，javac 桩编译通过）+ LocalServerSession 编排（CA 持久化/自动重签/端口回退，15 测试）+ Home「电脑端连接」区块（地址复制/指纹/客户端态）+ SpikePage 测试 6 + scripts/trust-local-ca.sh（macOS security/Windows certutil，实机验证安装/指纹比对/幂等）+ SPEC §5.6/CONTEXT/ADR-0009 同步）；**待验项 = 真机**（T09 承接）：app 起服务器 → 桌面 Chrome 连入转发 SDP → 传文件 SHA-256 一致；CA 信任全链路；Windows Chrome + Bonjour `.local` 解析；iOS 后台/锁屏边界
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
- 若证书摩擦不可接受 → 回到 ADR-0009 已接受的降级：电脑端维持两跳 QR（app↔app 不受影响）
- WSS 端口冲突/占用处理；同一 app 多网卡（WiFi+热点）地址展示选择

## Chromium 行为 spike 结论（2026-08-17，本机 playwright chromium-1200 实测）

> 30 分钟快验完成，全部实测（wss-server.mjs / spike-test.mjs 留在 .scratch/lan-discovery/spike/ 作协议参考实现）：
> 1. **wss 不被 mixed content 拦**：https 页 → `wss://127.0.0.1` / `wss://LAN-IP` 全部建立（仅明文 `ws://` 被拦：`Failed to construct WebSocket: insecure WebSocket connection may not be initiated from a page loaded over HTTPS`——ADP 前提证实，WSS 必需）
> 2. **Chrome 解析 `.local`（macOS）**：`wss://xiaodingdangdeMacBook.local:8443` 直接建立 ✓（macOS 经 mDNSResponder；Windows 需 Bonjour/T09 真机验）——**`.local` 路径让 DHCP 换 IP 免重签**
> 3. **CA 信任流成立**：`security add-trusted-cert`（login keychain）后、不带 `--ignore-certificate-errors` 的 Chromium 全部直连成功（IP + .local 两组）；本机 System keychain 已有早期会话安装的同款 CA（也生效）
> 4. **校验被强制执行**：未受信 CA 签发的证书 → 连接失败（close 1006，无绕过）
> 5. **PNA 不拦**：公开 https 页（GitHub Pages 上的 PWA）→ `wss://LAN-IP` 直接建立（无 Local Network Access 提示/拦截，chromium-1200）
>
> ### 机制拍板（决策 4 落地）
> **app 内自签（b 为主体）+ `.local` SAN（c 辅助）**：
> - CA 由 app 首次启动时生成（WebCrypto，WKWebView secure context）并持久化（CA 不变 → 桌面只信任一次，永不需要重信任）
> - 叶证书每次启动/网络变更自动重签：SAN = `DNS:<deviceId>.local` + `IP:` 当前各接口 IP + `IP:127.0.0.1`；**DHCP 换 IP → macOS 走 `.local` 零操作；IP 路径重输地址；永不动桌面信任**
> - 桌面一次信任：脚本经 `curl -k https://<addr>:8443/ca.crt` 取 CA → 校验 SHA-256 指纹（app 界面显示）→ `security add-trusted-cert`（macOS）/ `certutil -addstore -f Root`（Windows，T09 真机验）
> - 安全权衡（对应 ADR 选项 b）：CA 私钥存 app 内（OPFS），仅服务本用户 LAN，可接受（ADR-0009 已注释）
