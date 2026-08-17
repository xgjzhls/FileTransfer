# .local-certs 生成记录

自签测试证书（仅局域网测试用；`server.key` 为测试私钥，勿用于生产）。
手机信任 `ca.crt` 一次后，只要 **CA 不换**，换 IP/换机后只重签 server 证书即可，手机无需重装。

## 当前 SAN

`192.168.10.26, 10.213.80.3, 198.18.0.1, 127.0.0.1, 192.168.10.4, localhost`

- `192.168.10.26`：旧机器局域网 IP（保留）
- `10.213.80.3`：旧换机后 en0 局域网 IP（保留）
- `192.168.10.4`：当前机器 en0 局域网 IP（2026-08-15 加入，重签 server 证书；CA 未换，手机已装 ca.crt 信任继续有效）
- `198.18.0.1`：Clash TUN fake-ip（2026-08-14 应要求加入，其他设备无法经此访问本机）
- `127.0.0.1` / `localhost`：本机回环

## 重新生成步骤

换机/换 IP 后，**保留 CA**，只重签 server 证书（手机已装的 ca.crt 信任继续有效）：

```bash
cd .local-certs

# 1. 更新 SAN（旧 IP 保留，追加新 IP）
#    subjectAltName = IP:<旧IP>, IP:<新IP>, IP:127.0.0.1, DNS:localhost

# 2. 用现有 server.key 重新生成 CSR（CN 随意，浏览器只认 SAN）
openssl req -new -key server.key -out server.csr -subj "/CN=<新IP>"

# 3. 用现有 CA 重签（自动续用 ca.srl 递增序列号）
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 365 -extfile ext.cnf

# 4. 验证
openssl x509 -in server.crt -noout -text | grep -A1 "Subject Alternative"
openssl verify -CAfile ca.crt server.crt
```

若要整套重来（CA + server 全部新生成，所有设备需重装信任 ca.crt）：

```bash
cd .local-certs
openssl req -x509 -newkey rsa:2048 -days 365 -nodes -keyout ca.key -out ca.crt -subj "/CN=LocalTransfer Test CA"
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=<IP>"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -extfile ext.cnf
```


> **2026-08-17（T07/ADR-0009 决策 4 落地）**：电脑腿（桌面 Chrome → app 本地 WSS）的证书机制已改为
> **app 内自签**（CA 由 app 首次启动 WebCrypto 生成并持久化，叶证书按启动/网络变更自动重签，
> SAN = `DNS:<deviceId>.local` + 当前 IP + 127.0.0.1）——桌面一次性信任 app 的 CA 即可
> （`scripts/trust-local-ca.sh`），本目录的 OpenSSL CA 仅继续用于开发期本地 https 服务（如下）。

## 使用

```bash
# 本地信令
cd server
npx wrangler dev --port 8787 --ip 0.0.0.0 --local-protocol https \
  --https-key-path ../.local-certs/server.key --https-cert-path ../.local-certs/server.crt

# 前端
cd ..
VITE_HTTPS=1 npm run dev
```

手机访问 `https://<本机IP>:5173` 前需安装并信任 `ca.crt`（一次性）。
