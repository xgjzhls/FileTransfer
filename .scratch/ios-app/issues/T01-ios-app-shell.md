# T01: iOS app 壳骨架(现有 PWA 全流程在真机跑通)

**状态:** ready-for-agent

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
