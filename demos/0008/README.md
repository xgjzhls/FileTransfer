# Demo 0008：STUN / TURN 亲手实现

第 8 课的配套可运行代码。零依赖，只用 Node 内置模块（`dgram` / `crypto`）。

## 文件

| 文件 | 干什么 | 需要什么 |
|---|---|---|
| `stun-client.js` | 徒手构造 STUN Binding Request，问真实 STUN 服务器「我的公网地址」，解析 XOR-MAPPED-ADDRESS | 能出公网（大多数网络都行） |
| `stun-server.js` | 60 行迷你 STUN 服务器 —— 证明「STUN 服务器是一面镜子」是字面意思 | 无 |
| `turn-allocate.js` | 徒手完成 TURN Allocate 认证舞蹈（401 → 带凭据重发 → 拿到中继地址） | 本地 coturn |

## 1. STUN 客户端（走公网）

```bash
node stun-client.js                    # 默认 stun.cloudflare.com:3478
node stun-client.js stun.l.google.com 19302
```

输出包含：报文十六进制 + 逐字段注释 + 解析出的公网地址。

> 注意：报告的公网地址**只对那个 STUN 服务器有效**。对称 NAT 下发给别的目的地址会是另一个端口（第 3 课）。

## 2. 迷你 STUN 服务器（本地）

```bash
node stun-server.js 3478               # 终端 A：起服务器
node stun-client.js 127.0.0.1 3478     # 终端 B：连它
```

看 `stun-server.js` 就明白：所谓「照镜子」就是读 `rinfo.source`，XOR 一下魔数再塞回属性里。

## 3. TURN Allocate（本地 coturn）

先起 coturn（需 Docker）。注意：Docker Desktop（macOS）的 `--network=host` 绑定的是虚拟机
的环回地址，宿主机 `127.0.0.1` 连不上 —— 所以用端口映射：

```bash
docker run -d --rm --name coturn-demo \
  -p 3478:3478/udp -p 49160-49200:49160-49200/udp \
  coturn/coturn \
  -n --log-file=stdout \
  --lt-cred-mech --realm=example.org \
  --user=alice:secret123 \
  --fingerprint \
  --min-port=49160 --max-port=49200
```

Linux 上也可以用 `--network=host` 代替端口映射。

然后：

```bash
node turn-allocate.js alice secret123 example.org 127.0.0.1 3478
```

观察输出：第一次 Allocate 被 401 拒（带 REALM/NONCE）→ 算 `MD5(user:realm:pass)` → 加
USERNAME/REALM/NONCE/MESSAGE-INTEGRITY/FINGERPRINT 重发 → 拿到
`XOR-RELAYED-ADDRESS`（你的中继地址）+ `LIFETIME=600`。

收尾：`docker stop coturn-demo`。

## 参考

- RFC 8489 §6（STUN 报文格式）、§9.2（长期凭据）、§14.5（FINGERPRINT）
- RFC 8656 §4.2（Allocate 认证流程）、§13（方法）、§14（属性）
- coturn 官方镜像文档：<https://github.com/coturn/coturn/blob/master/docker/coturn/README.md>
