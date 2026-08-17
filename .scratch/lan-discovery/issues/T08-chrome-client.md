# T08: 电脑腿 B —— Chrome 端连接（输一次记住 + 重连 + 降级）

- 状态：✅ 代码完成（2026-08-17：src/lan/localClient.ts（地址解析/`lt.localServer` 持久化/退避重连 ≤5 次转 offline/GET / 设备信息 + URL 兜底/wire 信令收发，20 单测）；Home 桌面「本地服务器连接的设备」区块（地址输入 + 内联校验 + 信令已连/设备卡片/点选建连/忘记地址/失败重输提示 + 一键降级 QR）；app 端 LocalServerSession.onSignal 接线（桌面 offer/answer → ConnectionManager，桌面为发起方、app 回 answer）+ transport 'local' 路由 + 断线中断续传；传输：本地 WSS 只转信令、WebRTC 直连（smoke 实测：chromium+假服务器，GET / 设备信息 → wss 连入 → 压缩 sdp offer 经服务器转发 ✓）；**原生 CORS 补丁**：iOS/Android 服务器 GET `/` 与 `/ca.crt` 增加 `Access-Control-Allow-Origin: *`（桌面 PWA 跨源 fetch 必需；Swift parse + javac 验证通过）；offline 降级入口 OfflinePair openToken；e2e 按钮定位收敛 + 选择文件后等列表更新再点发送（消竞态））；**待验项 = 真机**（T09 承接）：app 起服务器 → 桌面 Chrome 连入 → 转发 SDP → 传文件 SHA-256 一致（1GB）；CA 信任全链路；DHCP 换 IP 重输；Windows Chrome + Bonjour `.local` 解析

## 目标
桌面 Chrome 网页连入 app 本地 WSS：地址输入一次 → 记住（`lt.localServer`）→ 自动重连 → 失败降级 QR。手机↔电脑离线免两跳。

## 验收标准（done when）
1. 输一次地址（app 界面显示的 IP:port）→ 建连 → 局域网区块出现该 app 设备 → 传文件 SHA-256 一致（1GB 标准）
2. 重开页面自动重连上次地址；连不上（app 未开服务器/地址失效）→ 明确错误 + 提示重输（DHCP 换 IP 场景）
3. 降级：本地服务器路径失败时一键回到 QR 两跳（§5.3）——不阻塞传输
4. 桌面无摄像头路径可用：以输入地址为主，不依赖扫码
5. 数据面：WSS 只转信令，WebRTC 直连（与 T07 验收 3 同证据）

## 备注
- Chrome 端逻辑在现有 PWA 内新增「本地服务器连接」模式，无新依赖、零安装
- 地址输入 UI：app 端展示的地址文本可复制/二维码（桌面无摄像头则手动；T07 已实现文本+复制，地址 QR 属 T09 打磨项）；地址含端口
- 与 T06 的「局域网区块」桌面端呈现衔接
- 评审修正（2026-08-17 复盘）：localClient 与 localServer 的 storage 默认实现去重（defaultStorage 导出复用）；连接代际守卫（慢 GET / 迟到结果不覆盖新地址，带单测）；SPEC §1 端口 8443→9443 文本漂移修复；原生 CORS 头（iOS/Android）补丁为本票验收 1 的必要前置（跨源 fetch 设备信息）
- T09 待验清单：1GB 真机 SHA-256；CA 信任全链路（macOS/Windows）；DHCP 换 IP 后重输路径；Windows Chrome + Bonjour `.local` 解析；app 侧地址二维码（可选打磨）
