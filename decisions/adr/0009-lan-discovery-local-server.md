# ADR-0009: 局域网发现 + 本地信令服务器（修订 ADR-0006 可见性门控）

- 状态：已接受（2026-08-16 用户确认）
- 日期：2026-08-16
- 来源：grill-with-docs 访谈（2026-08-16，三轮 frontier 访谈）
- 修订：ADR-0006 决策 4 的「PIN 门控可见性」——仅对在线房间设备保留；局域网发现设备同 LAN 直接可见可连

## 背景

- **技术前提变化**：ADR-0006/0007 的结论「纯浏览器无法枚举局域网设备」建立在两端都是浏览器的前提上。ADR-0008 之后手机端是 Capacitor 原生壳——原生层具备 UDP/mDNS/TCP 监听能力，**打破了该前提（对 app 端而言）**；ADR-0007 拒绝「桌面信令帮手」的理由之一「手机不能监听端口」同样不再成立（app 可以监听）
- **用户诉求**（本访谈）：离线（完全离线是主场景，ADR-0007）时摆脱两跳扫码，覆盖 app↔app 与 app↔电脑 两条腿
- **技术事实**（2026-08-16 核实）：
  - 浏览器无 mDNS/DNS-SD 浏览、无 UDP 组播/广播、无法监听端口（ADR-0006 已核实，对 Chrome 网页仍成立）→ **Chrome 网页只能主动连接，无法被发现**
  - WKWebView 内 WebRTC DataChannel 有已知问题：WebKit bug 174500（仅数据通道的应用做直连需摄像头/麦克风权限）；社区存在专用 shim（webviewrtcdatachannel / wkwebview-webrtc-shim）→ **app 内数据面能否复用现有 WebRTC 栈需 spike 验证**
  - Chrome 安全策略：https PWA 页面 → 明文 `ws://LAN-IP` 被 mixed content 硬拦；`http://IP` 顶级导航虽不拦但失去 secure context（OPFS 不可用）→ 电脑腿必须 **WSS + 可信证书**
  - Chrome 不解析 mDNS `.local` 域名（桌面侧能力待验，见 T07）→ 电脑腿地址需手动输入或扫码

## 决策

1. **局域网发现（app↔app）**：iOS+Android app 原生层 mDNS/DNS-SD 发现（服务类型 `_localtranfer._tcp`，TXT 携带设备名/ID/类型/信令端口/版本；iOS Network.framework NWAdvertiser/NWBrowser；Android NsdManager）。发现后发起方经**原生信令通道**（TCP 直连对端信令端口）交换 SDP/ICE——信令「单协议多载体」扩展为：WS / QR / 原生通道 / 本地 WSS 四种载体共用 `signal.payload`。
2. **同 LAN 直接可见可连（修订 ADR-0006）**：局域网发现列表无需 PIN 门控，物理同在局域网即信任，点选即连；传输仍 WebRTC DTLS 加密；**可见性开关默认开、设置页可关**（关 = 不出现在他人列表、也不主动发现）。在线房间设备仍受 ADR-0006 PIN 门控（房间码即凭证）不变。
3. **数据面先 spike 再定**：T01 spike 验证 WKWebView（Capacitor）内 RTCPeerConnection + DataChannel 可用性（建连 / bug 174500 权限 / 吞吐）。分支 A（可用）：原生只管发现+信令，传输/续传/分块/OPFS 全复用现有栈；分支 B（不可用）：app↔app 原生 TCP 数据面（传输协议在原生层或桥接实现），**电脑腿顺延**。
4. **电脑腿 = app 本地信令服务器**：app 原生层监听 WSS（**默认 9443**，被占依次试 9444/9445），桌面 Chrome 网页主动连入；服务器**只转信令**（SDP/ICE），文件数据仍 WebRTC 直连——不违反「数据不经过任何中间设备」约束（app 是端点，非第三方中继）。证书用 `.local-certs` CA 签发，**桌面 Chrome 一次性信任 CA**（脚本化；非桌面应用，不破「零安装」）。

   > **决策 4 落地（T07 spike 2026-08-17 拍板，见 T07 备注）**：**WSS 端口定为 9443 而非初稿的 8443**——与 app↔app 原生信令 TCP 端口（8443，SPEC §5.5）分离，避免双监听冲突（SPEC §5.6 / CONTEXT 同步）；app 内自签为主体——CA 首次启动 WebCrypto 生成并持久化（CA 不变 → 桌面只信任一次），叶证书按启动/网络变更自动重签，SAN = `DNS:<deviceId>.local` + 当前接口 IP + 127.0.0.1；`.local` SAN + 桌面解析（macOS 已验证）使 DHCP 换 IP 免重签。`security add-trusted-cert`（macOS）/ `certutil`（Windows）脚本化信任。
5. **地址发现（电脑腿）**：app 界面显示地址（IP:port），Chrome 输一次存 `lt.localServer`，重开自动重连；DHCP 换 IP 重输；失败降级现有 QR 流程。
6. **UI**：设备列表分「在线房间」「局域网发现」两个区块（来源标注）；在线场景沿用自动回房（ADR-0006），在线房间为主、局域网区块仍显示（app 端）；信令不可达（离线）时局域网区块为主（自动聚焦）。桌面端浏览器无 mDNS 能力，显示「本地服务器连接的设备」区块（T08 接入后列出电脑设备）。
7. **平台**：iOS + Android 同步实现发现插件（跨平台 mDNS 互操作是最大技术风险，T03 真机验证）。

## 理由

- app 端原生能力使「离线免扫码」从物理不可行变为可行，且不破坏任何既有约束（零安装 / 数据直连 / 电脑不必在场 / 完全离线可用）
- 电脑腿采用「app 内嵌信令服务器」而非 ADR-0007 拒绝的「桌面信令帮手」：帮手内嵌于已存在的 app（不新增安装物），且数据面仍直连（不引入中继）——既兑现「手机↔电脑离线少一跳」，又守住定位
- WSS + 一次性信任本地 CA：是 https PWA 连局域网服务唯一合规通道（明文被 mixed content 拦、http 顶级导航失去 OPFS）；CA 是证书非应用，桌面端零安装不变
- 可见性改为「同 LAN 直接可见」：与「物理在场即信任」安全模型一致（ADR-0006 已接受该模型，PIN 门控只是列表可见性）；家庭/办公局域网场景收益（免码直连）大于风险（同网段他人可见设备名——用可关开关兜底）

## 后果

- 正面：
  - app↔app 离线从「两跳扫码」变为「打开即见设备，点选即传」（ADR-0007 打磨后的主摩擦消灭）
  - 手机↔电脑离线从「两跳扫码/粘贴」变为「输一次地址」或二维码（若桌面有摄像头）
  - 数据面若 spike 分支 A：传输协议/续传/存储全部零改动，风险集中在原生发现层
- 负面 / 边界：
  - **证书机制未最终定**：app 需提供 CA 签发且 SAN 覆盖桌面连接地址的证书，但 IP 动态——机制选项（按 IP 重签 / CA 密钥随包 / `.local` SAN + 桌面解析能力）由 T07 定，属本 ADR 的落地风险
  - 原生信令通道（app↔app）v1 为明文 TCP：同 LAN 信任模型下接受（与决策 2 一致）；若需对抗同网段主动攻击者，后续加 TLS
  - Android↔iOS mDNS 互操作（RFC 6762/6763 兼容性、TXT 编码）待真机验证（T03）；失败则退回「同平台发现 + QR 跨平台」
  - iOS 本地网络权限首次弹窗（NSLocalNetworkUsageDescription）；拒绝后功能不可用需引导重开
  - AP 隔离 / 跨 VLAN：mDNS 与直连均失败 → 降级 QR（保持现状）
  - iOS 后台/锁屏：原生监听与发现受挂起限制（前台为主，文档化）
  - ADR-0007「考虑过的选项 1（桌面信令帮手）」未翻案——桌面端仍不做任何安装物；本 ADR 只是把帮手内嵌进已存在的手机 app

## 参考资料

- WebKit bug 174500（仅数据通道应用直连需摄像头权限）；caniwebview RTCDataChannel（WKWebView 支持追踪）
- webviewrtcdatachannel / wkwebview-webrtc-shim（WKWebView DataChannel shim）
- Chrome mixed content / Private Network Access 行为（https→ws:// 硬拦；顶级导航 http 失去 secure context）
- RFC 6762（mDNS）/ RFC 6763（DNS-SD）
- 本项目：ADR-0006（对称 PIN + 门控）、ADR-0007（两跳上限）、ADR-0008（iOS app 壳）、SPEC §5/§6
