# HANDOFF — LocalTransfer（换机交接）

> 交接时间：2026-08-13。用途：**在新电脑上继续开发**。
> 阅读顺序：本文件 → `CONTEXT.md` → `SPEC.md` → `decisions/adr/` → `.scratch/transfer/issues/`（按依赖顺序）。

## 项目一句话
零安装的局域网 P2P 文件传输 PWA：iPhone ↔ iPad ↔ 电脑（全部为浏览器）。单文件 ≤10GB、批量、自动续传、可存「文件」App / 「照片」库。数据面离线可用，信令面在线（WS 房间）+ 离线（二维码）双通道。

## 仓库状态
- 远程：`git@github.com:xgjzhls/FileTransfer.git`（origin）
- 分支：`main`（规范主线：文档 + SPEC + 8 张票 + T01 应用骨架）；`prototype/storage-spike`（spike 原型档案，只读参考，勿动）
- 当前：main @ `6fc2ab6`，工作区干净

## 已有产物（先读，勿重复造）
| 路径 | 内容 |
|---|---|
| `CONTEXT.md` | 约束、词汇、已拍板决策、spike 结论、部署现状 |
| `SPEC.md` | 正式规格：传输协议、存储层、信令、UI、PWA、里程碑 |
| `decisions/adr/0001-0005` | 架构决策（零原生应用 / QR 信令 / HTTPS 引导 / 双通道信令 / bitfield 续传 + ordered） |
| `.scratch/transfer/issues/T01-T08` | 8 张实现票（含阻塞边与验收标准），T01 已完成 |
| `src/` `public/` `docs/` | T01 应用骨架（React + TS7 + Vite + PWA）；`docs/` 是构建产物（Pages 部署源） |

## 当前进度与下一步
- 流程位置：grill-with-docs → SPEC → to-tickets → **实现中**（T01 ✅ `d889f56`，T02 ✅ `704ffde`，T03 代码 ✅ `4a00fe6`）
- **下一步：T03 部署**（人类步骤，见下）→ 完成后即可开始 T04（WebRTC tracer bullet）
- 依赖图：T03 → T04 → T05 → T06；T04 ← T07；T05/06/07 → T08（详见各票）
- T02 遗留：验收标准 6 真机复测（iPhone 写入 1GB+ 并拼接）待用户设备执行；`npm test` 37/37 绿
- T03 遗留：验收标准 4 部署（wrangler login + deploy → 填 .env → 对 wss 重跑 `node server/smoke.mjs`）

## 新电脑环境搭建（关键，按序执行）
1. Node ≥ 22（项目在 v24.12.0 上构建验证）；克隆仓库后 `npm install`
2. **GitHub SSH 走代理**：用户网络直连 GitHub 不通（DNS 被 fake-ip 劫持），Clash 混合端口 `127.0.0.1:7890`。`~/.ssh/config` 需配：
   ```
   Host github.com
     HostName github.com
     IdentityFile ~/.ssh/github   # 新电脑需自己的 key，旧机 key 不可沿用
     ProxyCommand nc -X connect -x 127.0.0.1:7890 %h %p
   ```
3. Git 身份：若未配置 user.name/email，提交会 fallback 为 `LocalTransfer Dev`
4. pi 技能流：如需同款（ask-matt / handoff / implement / tdd 等），把旧机 `~/.pi/agent/skills` 与 `~/.pi/agent/settings.json`（含已装扩展 web-search / btw / subagents / ask-user-question / todo）拷贝过来，或重装 pi + 扩展
5. **TS7 陷阱**：Go 原生编译器的 DOM 类型缺 OPFS sync access handle，`src/spike/fs-sync-access.d.ts` 已补齐——勿删

## 部署与验证
- GitHub Pages legacy + `/docs`（main 分支），用户已把 Pages 源切到 main
- 换机后先验证：`https://xgjzhls.github.io/FileTransfer/` 应是新应用（首页 / 设置 / Spike 测试 三页 + 顶导航），断网重开可用（SW 预缓存）
- 更新代码流程：`npm run build` → `rm -rf docs && mkdir docs && cp -r dist/* docs/ && rm -f docs/sw.ts && touch docs/.nojekyll` → commit + push
- 曾试 Actions workflow + deploy-pages，因 `github-pages` 环境 branch_policy 拦截失败，已弃用；正式版可回归（需先把环境策略改 All branches）

## 已知边界（spike 实测，细节在 CONTEXT.md「关键风险」）
- iOS OPFS：**无 createWritable**，只有 `createSyncAccessHandle`（须 Worker 内）；配额宽松（40GB+ 未触发）
- iOS 存储按浏览器 / 独立 PWA 分区隔离；`estimate()` 恒返回 0
- Web Share 大视频（~600MB）页面崩溃 → 照片门控阈值 <300MB（`PHOTO_GATE_BYTES` 配置常量），大文件走 Files 导入
- 孤儿数据：中断会残留 OPFS 且不可见 → 应用需启动扫描 + 设置页清理（T02 范围）

## 实现流程约定（ask-matt 主流程）
- 每张票一个 `/implement` 会话（票间 `/clear`），内部 `/tdd`（红-绿-重构），提交前 `/code-review`（双轴：标准 + 规格）
- 票内「验收标准」即 done 条件；真机验证步骤需要用户设备（iPhone/iPad，iOS 17+）

## 敏感信息
- 本仓库无密钥、无凭据。T03 部署 Cloudflare 时需用户交互式登录（`wrangler login` 或 API Token），**切勿写入仓库**
- 代理、SSH key 等属本机配置，不入库

## suggested skills
- `tdd` —— T02 起每张票（测试先行；单测用 Vitest）
- `code-review` —— 每张票提交前双轴评审
- `diagnosing-bugs` —— 传输/存储层若遇难缠 bug（尤其 iOS Safari 行为差异）
- `wizard` —— T03 的 Cloudflare 账号 / Worker / Durable Objects 配置属人类步骤
- `writing-for-agents` —— 若需更新 skills 或 AGENTS.md
