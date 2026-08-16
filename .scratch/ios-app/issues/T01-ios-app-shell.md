# T01: iOS app 壳骨架(现有 PWA 全流程在真机跑通)

**状态:** ✅ 代码完成（2026-08-16）；真机已安装启动（iPhone 11 · iOS 18，devicectl launch 成功）；配对/收发/导出真机验收项并入 T05 执行

**完成记录:**
- 根级 Capacitor 8 工程（SPM 模式）：`capacitor.config.ts`（appId local.transfer.app, webDir dist）+ `ios/` 平台目录
- 一键脚本 `scripts/ios-deploy.sh`：build:app → cap sync → xcodebuild（自动签名，DEVELOPMENT_TEAM 已入 pbxproj）→ devicectl 安装+启动
- Info.plist 相机权限（NSCameraUsageDescription 中文说明）
- app 构建禁用 SW：vite.config `LT_APP_BUILD=1` 时替换 VitePWA 为 pwa-stub（`virtual:pwa-register` 无操作），产物无 sw.js；网页构建不受影响
- `npm test`/build/lint 全绿；Pages 流程未动（docs/ 仍由 web 构建产物承载）

**真机验证（已做）:** xcodebuild BUILD SUCCEEDED → devicectl install/launch 成功（iPhone 11）

**阻塞:** 无(可立即开工)

**被阻塞者:** T02、T03、T04

**引用:** SPEC §8 里程碑9;ADR-0008(决策 #1,修订「不做原生应用」约束);原型分支 `prototype/ios-app-spike`(Capacitor 8 SPM 模式 + xcodebuild/devicectl 自动化构建部署回路已验)

## What to build

把现有 PWA 构建产物接入 Capacitor 8 工程(SPM 模式),命令行一键构建并部署到真机;app 内现有收发/配对/导出全流程可用。这是 tracer bullet——先证「壳内全功能」,后续导出改造都建立在它之上。

## 方案

- 根级 Capacitor 工程(capacitor.config + ios/ 平台目录,SPM 模式,复用 spike 验证过的插件链接/自动注册机制)
- 构建脚本:`npm run build`(app 构建禁用 SW 注入——壳内 Service Worker 不可用,离线由本地打包资源承担)→ `cap sync` → `xcodebuild` → `devicectl` 安装启动(把 spike 的手动回路固化为一条命令)
- Info.plist:相机权限说明(离线扫码配对需要 `NSCameraUsageDescription`)
- 真机验证:在线 PIN 配对 / 离线扫码配对、收发文件(含大文件)、现有导出路径(分享/下载)全部照常
- 回归:网页版构建与 GitHub Pages 部署流程不受影响

## 验收标准(done when)

- [ ] 根级 Capacitor 工程就位;一条脚本命令完成 构建→同步→真机安装→启动
- [ ] 壳内跑通:配对(扫码+在线)、收发文件、现有分享/下载导出路径
- [ ] 相机权限首次使用正确弹窗,授权后扫码可用
- [ ] app 构建产物不注册 SW,无 SW 相关报错
- [ ] `npm test` + `npm run build` + lint 全绿;Pages 部署流程不受影响
