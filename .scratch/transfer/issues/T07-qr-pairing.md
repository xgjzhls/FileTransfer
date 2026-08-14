# T07: 离线二维码配对

- 状态：✅ 代码完成（src/qr/ + src/pages/OfflinePair.tsx + ConnectionManager QR 方法；qrCodec 9 单测 + ConnectionManager 6 单测；e2e 14-15/14-15 绿）；⚠️ 验收 6 真机（两部 iPhone / iPhone+Mac 纯局域网）待用户
- 阻塞：T04
- 被阻塞者：T08
- 引用：SPEC §5.3；ADR-0002/0004
- 完成备注：`npm test` 196/196；`E2E_NO_PROXY=1 node scripts/e2e.mjs` 全量模式 15/15（含 T07 完整 QR 配对 + 传输；本机 Clash fake-ip 干扰时降级 14/14）；详见文末「实现备注」

## 目标
无互联网/无信令服务时的配对：二维码交换压缩 SDP，建立与在线路径相同的连接（单协议双载体）。

## 验收标准（done when）
1. ✅ offer 端生成二维码（gzip+b64 的 `signal.payload`，gathering complete 后序列化），answer 端扫码解码生成 answer 二维码，offer 端再扫 → 建连（e2e 粘贴路径全流程 + 真机待验）
2. ✅ 扫码用 `qr-scanner`（封装 jsQR + 摄像头循环，兼容 iOS Safari 权限流）；渲染用 `qrcode`（均动态 import 懒加载）
3. ✅ 摄像头权限引导：HTTPS 源 + 首次授权；错误文案区分权限拒绝（含 HTTPS 提示）/无摄像头/占用（cameraErrorText；真机 iOS 首次授权待验）
4. ✅ 建连后完全复用 T04/T05/T06 路径（含离线断连后重新扫码续传）
5. ✅ 电脑无摄像头 fallback：手动粘贴配对码文本（offer/answer 双向，超出票面「仅 answer」的最低要求）
6. ⚠️ 真机测试：两部 iPhone（或 iPhone+Mac）关网/断 Wi-Fi 路由器外网，纯局域网扫码配对传输成功（人类步骤，T08 多端联调一并验）

## 备注
- 二维码即发现机制（无在线列表）；「谁先扫」交互：发送端（offerer）显示配对码 → 接收端扫码 → 接收端显示回码 → 发送端扫码/粘贴
- **超限策略偏差（已决策）**：票面「若超限需截断非必要 candidate」未实现——`encodeQrText` 超过 2800 字符直接报错提示重试。理由：无 STUN/TURN（仅 host/mDNS candidates），截断收益低、风险高（可能断连）；实测 666-671 字符远低于上限
- 断连后重新配对：connState 失败/断开 → 重新扫码配对 → connected → 自动 resumeSend（只补缺失块）；已知边缘：若在 ICE 失败检测（~5-15s）前就完成重新配对，不会自动触发续传（手动 QR 步骤耗时远大于该窗口，实际不可达）

## 实现备注（2026-08-14）

### 客户端
- `src/qr/qrCodec.ts`：信封 `base64url(gzip({v:1,kind,sdp}))`（SPEC §5.3）；复用 sdpCodec 的 gzip+b64 管线；版本/kind/sdp 校验；单码容量上限 2800 字符（QR v40-L）
- `src/qr/qrRender.ts` / `qrScan.ts`：qrcode / qr-scanner 薄封装，动态 import 懒加载（vite 自动 code-split；worker 脚本自动打包）
- `src/pages/OfflinePair.tsx`：状态机 pick → offer-show → answer-wait → answer-show → done；发送端/接收端两个方向都支持「摄像头扫码」+「手动粘贴文本」；配对成功自动收起；断连提示重新配对
- `ConnectionManager`：createQrOffer / handleQrOffer / handleQrAnswer（与 WS 路径同一 RtcPeer，不经信令）
- Home 传输区：QR 连接建立后完全复用现有 connState 驱动（断连→重新配对→自动续传）

### 测试
- `qrCodec.test.ts`：9 个单测（往返/校验/容量）
- `connection.test.ts`：QR 流程 6 个单测（offer/answer/数据面互通）
- `scripts/e2e.mjs`：WebRTC 探测改为**双页真实交换**（旧同页 loopback 在 fake-ip TUN 下误判，双页/双设备场景才贴近实际）；新增 T07 步骤：A 生成配对码 → B 粘贴生成回码 → A 粘贴 → 两端 connected → 离线传输完成（全量模式）；降级模式验证 SDP 交换

### 顺带修复（e2e 全量模式暴露的 T06 相关 bug）
1. **接收端重启续传缺 file_done**：存储记录已完整（快速传输在杀页面前已完成）的文件，重启后 meta 不再触发 file_done → UI 无导出入口。修复：`Receiver.doneFileIds()` + Controller 补发 file_done（UI + 发送端）
2. **手动重连时在途发送不续传**：对端重载后旧连接仍显示 connected（ICE 失败检测延迟），点「连接」→ newPeer 关旧 peer，但 interruptedRef 未置位 → 旧 Sender 停在死 dc 上永久等待、新连接不 resumeSend。修复：`connectTo` 检测 `controller.hasActiveSend()`（在途）→ 置 interrupted + abort 旧循环 → 新连接建立后自动续传；`hasActiveSend` 仅覆盖**在途**发送（完成后不算，避免向新对端误发旧批次）
