# 手机无法访问本地 HTTPS 服务 —— 排查记录（2026-08-14 修订版）

> **最终根因：路由器/AP 的客户端隔离（AP Isolation / Client Isolation）**，与
> Mac 配置、证书、应用都无关。排查途中一度误判为 macOS 应用防火墙（红鲱鱼），
> 已更正。本文保留完整排查链与教训，供下次直接参考。

## 症状

- Mac 本机一切正常：`curl -k https://10.213.80.3:5173` → 200、服务监听正常、
  路由健康、网关 ping 通
- 手机/其他设备：转圈超时 / "Safari 无法连接到服务器"（**非**证书警告）
- 已确认：同 Wi-Fi（A-WIFI）、同网段（10.213.80.x）、手机无 VPN、ARP 能解析到手机

## 决定性证据（nc 双向 TCP 测试，30 秒出结论，无需 root）

| 命令 | 结果 | 含义 |
|---|---|---|
| `nc -vz -w3 10.213.80.3 8000` | succeeded | Mac 本机服务正常 |
| `nc -vz -w3 10.213.80.1 80` | succeeded | Mac → 路由器正常 |
| `nc -vz -w3 10.213.80.248 80` | **timed out** | **客户端间 TCP 被网络拦截** |
| `nc -vz -w3 10.213.80.248 443` | **timed out** | 同上（双向都验证过） |
| `arp -d 10.213.80.248; ping; arp -an` | 能重新解析 | 二层可达，三层 TCP 被拦 |

**判据：路由器能通 + 客户端之间双向 TCP 不通 + ARP 二层可达 = 客户端隔离。**

## 排查弯路与教训

1. **macOS 应用防火墙**：一度被怀疑（开启时连不上），但关闭后依然连不上 → 排除。
   教训：单变量实验时，"防火墙开关"与"网络状态变化"发生了时间耦合，误判因果。
2. **证书 SAN**：重新签发过含新 IP 的证书，但证书问题症状是"警告"，不是"无法连接" → 排除。
3. **tcpdump 抓包**：两次都在 Wi-Fi 接口上卡死（进程不退出、文件 0 字节），得到
   误导性的"0 包"结论。**教训：抓包前必须先自检**（对目标端口发一个自己的包验证
   管线通），否则 0 包不说明任何问题。
4. **决定性工具是 nc 双向测试**：不需要 root、不需要抓包、不需要用户配合，一把梭。

## 解决方案

1. **如果是自己的路由器**：登录 `http://10.213.80.1`，关闭
   "AP 隔离 / 客户端隔离 / 访客隔离"，或把设备切到未隔离的 SSID / 频段。
2. **如果是共享 / 园区 / 办公网络（无法改设置）**：
   - **iPhone 热点**：Mac 连手机热点 → 双方 172.20.10.x，无隔离
     （注意：Mac 的 IP 会变，证书 SAN 需补新 IP 或手机临时信任）
   - **Mac 开热点（互联网共享）**：Mac 分享当前网络，手机连 Mac 的热点
   - **网线直连**：Mac ↔ 手机（USB-C 转 RJ45）
3. **应用层影响**：客户端隔离的网络下，WebRTC P2P（两台设备互传文件）也无法工作
   ——host candidate（局域网 IP）被拦、项目无 TURN 中继。**此类网络跑不了局域网
   传输应用**，不是应用 bug。

## 检查清单（手机连不上时按序排查）

1. [ ] 同 Wi-Fi、同网段（设置里确认，IP 为 10.213.80.x）
2. [ ] 本机自测：`curl -k https://<MacIP>:5173` 通
3. [ ] 手机能打开路由器管理页 `http://<网关IP>`
4. [ ] **nc 双向测试**（决定性）：Mac `nc -vz -w3 <手机IP> 80` 超时 = 网络隔离
5. [ ] 路由器设置：AP 隔离 / 客户端隔离 / 访客网络
6. [ ] 证书：手机已装并完全信任 ca.crt（否则报证书警告，症状不同）

## 信令服务器连不上（开发环境，PIN 后一直重连/离线）——排查记录（2026-08-15）

> **症状**：输入 PIN → 状态停在「连接中…/重连中…」→ 最终「离线」；浏览器 console 有
> `WebSocket connection to 'wss://<IP>:8787/ws?...' failed: ... net::ERR_CERT_*`。

**根因：wrangler dev / vite dev 不会热加载证书与 .env 改动，IP 变了但进程没重启。**
本机 IP 从旧值变成新值后：证书重签了（server.crt 含新 IP）、`.env.development` 也改了，
但两个 dev 进程还是按**启动时**的旧值运行 → 浏览器拿旧证书校验新 IP，
`ERR_CERT_COMMON_NAME_INVALID`（证书没新 IP 的 SAN）或 `ERR_CERT_AUTHORITY_INVALID`（设备没装/没信 ca.crt）。

排查要点：
1. **确认前端实际用的信令 URL**（vite 可能缓存旧 env）：
   `curl -sk https://localhost:5173/src/pages/Home.tsx | grep -o 'VITE_SIGNALING_WSS[^,]*'`
   应与 `.env.development` 一致；不一致 → 重启 vite（`.env` 改动只在启动时读一次）。
2. **确认 wrangler dev 正在服务哪张证书**：
   `echo | openssl s_client -connect localhost:8787 2>/dev/null | openssl x509 -noout -text | grep -A1 "Subject Alternative"`
   必须含当前 en0 IP；不含 → 重启 wrangler dev（证书在启动时读一次，**不热加载**）。
3. 用 CA 验证链路（模拟信任 ca.crt 的设备）：`curl --cacert .local-certs/ca.crt https://<IP>:8787/` 应 200。
4. 冒烟：`cd server && NODE_EXTRA_CA_CERTS=../.local-certs/ca.crt node smoke.mjs https://<IP>:8787` → 8/8。
5. 设备侧：手机装并完全信任 ca.crt（一次性）；桌面 Chrome 访问 `https://<IP>:8787` 点「继续前往」豁免一次。

**正确流程（IP 变化后）**：改 `.env.development` → 重启 vite → 重启 wrangler dev → 设备测。
证书重签步骤见 `.local-certs/README.md`（CA 不换则手机无需重装）。

## 命令速查

```bash
nc -vz -w3 <IP> <port>                              # TCP 连通性（决定性测试）
arp -d <IP>; ping -c1 <IP>; arp -an | grep <IP>     # 二层可达性复核
curl -sk https://10.213.80.3:5173/                  # 本机自测
lsof -nP -iTCP -sTCP:LISTEN | grep -E "5173|8787"   # 监听端口
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate  # 防火墙状态
# tcpdump 抓包前务必自检管线（对目标端口先发一个自己的包），否则 0 包≠无流量
```
