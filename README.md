# LocalTransfer — 局域网 P2P 文件传输

零安装的局域网 P2P 文件传输：iPhone ↔ iPad ↔ 电脑（全部为浏览器）。单文件 ≤10GB、批量、自动续传、可存「文件」App /「照片」库。数据面离线可用（WebRTC 局域网直连），信令面在线（WS 房间）+ 离线（二维码）双通道。

- 约束 / 决策 / 词汇表：[CONTEXT.md](CONTEXT.md)
- 正式规格：[SPEC.md](SPEC.md)
- 架构决策：[decisions/adr/](decisions/adr/)

## 网页版（PWA）

```bash
npm install
npm run dev          # 本地开发（VITE_HTTPS=1 启 https + 局域网监听，见 .env.development）
npm test             # 单测
npm run build        # 构建到 dist/（含 Service Worker 预缓存）
```

Pages 部署（legacy 模式，源 = main 分支 /docs）：`npm run build` → 复制 `dist/*` 到 `docs/`（保留 `docs/agents/`）→ 提交推送，Pages 自动重建。

## iOS app 壳（ADR-0008，Capacitor 8）

同一套 Web 代码经 WKWebView 打包；app 内导出主路径 = 「导出到文件夹…」（原生文件夹选择 + 分块流式拷贝，峰值内存 = 块大小），分享为次级按钮（@capacitor/share）。

前置：Xcode 16+、Apple ID（个人免费签名）。

```bash
npm run build:app    # app 构建（禁用 SW 注入，壳内 SW 不可用）
npx cap sync ios     # 同步 webDir + 插件注册（folder-export / share，SPM 自动链接）
bash scripts/ios-deploy.sh   # 一键：构建 → sync → xcodebuild → 真机安装 → 启动
```

### 免费签名 7 天重签

个人免费开发者签名**每 7 天过期**，过期后 app 无法打开，需重签（同一台电脑重新执行 `bash scripts/ios-deploy.sh` 即可，数据保留）。签名与开发团队配置在 `ios/App/App.xcodeproj`（DEVELOPMENT_TEAM）；换机器/换账号后需改。

首次真机运行需在 iPhone 上信任开发者证书：设置 → 通用 → VPN 与设备管理 → 你的 Apple ID → 信任。

### 壳内与网页版的差异（数据不迁移）

- **网页版 OPFS 数据不随 app 迁移**：iOS 各浏览器/独立 PWA/app 的存储分区互相隔离，网页版已收文件在 app 内不可见，需重新接收
- Service Worker 不可用：离线语义 = 本地打包资源（构建产物全量随包）
- 每次导出重新选文件夹（v1 不持久化授权）

## 本地测试

- 信令服务（本地）：`cd server && npx wrangler dev --port 8787 --ip 0.0.0.0 --local-protocol https --https-key-path ../.local-certs/server.key --https-cert-path ../.local-certs/server.crt`
- 证书：`.local-certs/`（自签，手机安装 ca.crt + 完全信任后可用）；SAN 含 localhost / 局域网 IP，换 IP 后按 `.local-certs/README.md` 重签
- 排障见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
