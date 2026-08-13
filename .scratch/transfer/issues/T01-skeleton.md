# T01: 项目骨架 + PWA + 部署

- 状态：✅ 已完成（d889f56）
- 阻塞：无
- 被阻塞者：T02, T04
- 引用：SPEC §2/§7；ADR-0003；`prototype/storage-spike` 分支（骨架与 spike 页已在此分支验证过构建/部署）

## 目标
把 main 从纯文档仓库变成可构建、可部署、离线可用的 PWA 骨架（React + TS + Vite + vite-plugin-pwa），并接上 GitHub Pages 部署。spike 页作为 `/spike` 路由保留（或独立子页），供真机复测。

## 验收标准（done when）
1. `npm run build` 通过（tsc -b + vite），产物含 SW（vite-plugin-pwa 预缓存全部静态资源）
2. `npm run dev` 可本地开发；SW 在 localhost 正常注册
3. 部署流程可用：main 推送到 GitHub Pages（延续 legacy + `/docs` 模式，见 CONTEXT.md 部署现状；或恢复 Actions 工作流——注意 github-pages 环境 branch_policy，需先改 All branches）
4. 站点离线可用：断网重开仍是完整应用（SW 缓存生效）
5. 基础页面结构就位：首页（房间/设备）、设置页、（spike 页）

## 备注
- 复用 spike 分支已验证的依赖集（react 19 + vite + TS7）；TS7 的 DOM 类型缺口（sync access handle）已在 spike 分支补过，需随骨架迁入
- 迁移 spike 页时保留其「清理按钮」等已验证交互
