# 手机无法访问本地 HTTPS 服务 —— 排查记录

> **2026-08-14** 真机联调：手机（10.213.80.248）和另一台设备都无法打开
> `https://10.213.80.3:5173`，浏览器报"无法连接服务器"（转圈超时，**非**证书警告）。
> 最终定位：**macOS 应用防火墙**。本文记录完整排查方法 + 修复步骤。

## 症状

- Mac 本机 `curl -k https://10.213.80.3:5173` → **200**（服务本身正常）
- 手机 / 其他同网设备 → 转圈超时 / "Safari 无法连接到服务器"
- 不是"证书不受信任"提示 → 与 ca.crt 信任无关

## 根因（三层叠加）

1. **macOS 应用防火墙开启**（`socketfilterfw` state=1）
2. 跑 5173 的 node（nvm v24，未签名）和跑 8787 的 workerd **不在放行列表**
   → 外部进来的连接被默认静默丢弃
3. **Stealth 模式开启**：Mac 对探测包不回应 → 外部表现为"超时"而非"拒绝"，
   极具迷惑性
4. **坑**：事后把 node/workerd 加进放行列表，**对已运行的进程不生效**
   （防火墙按进程缓存决策），必须**重启 dev 进程**后规则才起作用

## 判断方法（决策树）

| # | 实验 | 做法 | 结论 |
|---|------|------|------|
| 0 | 本机自测 | `curl -sk https://<本机IP>:5173` | 200 → 服务端 OK，问题在链路 |
| 1 | 第二设备对照组 | 另一台同网设备打开同一 URL | 它也失败 → 不是手机个例 |
| 2 | 手机通 LAN 吗 | 手机 Safari 开 `http://<网关IP>` | 能开 → 手机网络本身正常 |
| 3 | 路由器隔离? | Mac 上 `arp -an \| grep <手机IP>` | 有条目 → L2 通，**AP 隔离可排除** |
| 4 | ping 手机 | `ping <手机IP>` | iOS 常不回应 ICMP，**不能作数** |
| 5 | **关防火墙对照** | `--setglobalstate off` 后手机重试 | 手机能开 → **实锤是防火墙** |

关键区分点：**能通 = 路由器 OK；设备互访失败但 L2（ARP）正常 = Mac 侧拦截**。
"所有外部设备都进不来、Mac 本机一切正常"是 Mac 防火墙的典型指纹。

## 修复步骤

```bash
# 1. 放行两个进程（需要管理员权限；GUI：系统设置 → 网络 → 防火墙 → 选项）
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add \
  "$HOME/.nvm/versions/node/v24.12.0/bin/node" --allow
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add \
  "<repo>/node_modules/@cloudflare/workerd-darwin-64/bin/workerd" --allow

# 2. 关闭 Stealth 模式（不关则外部连接表现为"超时"）
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off

# 3. 关键：重启 dev 进程，放行规则才对运行中的进程生效
#    杀掉 vite / wrangler dev 后重新启动：
cd <repo> && VITE_HTTPS=1 npm run dev
cd <repo>/server && npx wrangler dev --port 8787 --ip 0.0.0.0 \
  --local-protocol https --https-key-path ../.local-certs/server.key \
  --https-cert-path ../.local-certs/server.crt
```

## 检查清单（手机连不上时按序排查）

1. [ ] 手机与电脑同一 Wi-Fi、IP 同网段（10.213.80.x）
2. [ ] 本机 `curl -sk https://<IP>:5173` 通（服务端 OK）
3. [ ] 手机能打开路由器管理页 → 手机网络正常
4. [ ] 路由器未开 AP 隔离/访客隔离（Mac `arp -an` 能见手机条目）
5. [ ] macOS 防火墙：node + workerd 在放行列表、Stealth 已关
6. [ ] dev 进程是在放行**之后**重启的
7. [ ] 手机已装并"完全信任" ca.crt（否则报证书警告，症状不同）

## 命令速查

```bash
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate   # 防火墙状态
/usr/libexec/ApplicationFirewall/socketfilterfw --listapps         # 放行列表
/usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off
lsof -nP -iTCP -sTCP:LISTEN | grep -E "5173|8787"                  # 监听端口
curl -sk https://10.213.80.3:5173/                                 # 本机自测
```
