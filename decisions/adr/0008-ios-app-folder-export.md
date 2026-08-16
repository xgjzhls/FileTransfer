# ADR-0008: iOS 打包 app + 原生文件夹选择,分块流式导出(网页版 share 内存问题的解法)

- 状态:已接受(2026-08-16 用户确认)
- 日期:2026-08-16
- 来源:grill-with-docs 访谈(2026-08-16);平台事实经 2026-08-16 web 调研核实
- 修订:本 ADR **修订 CONTEXT.md 约束「不做原生应用」**(见「决策 #1」)

## 背景

- **痛点**:iOS 网页版导出走 `navigator.share`,每次分享 Safari 都把文件**整载进内存**再出分享面板(OS 序列化行为,网页端无法改变);~600MB 视频调起分享曾致渲染进程崩溃(spike 实测,CONTEXT 开放问题 #1)。T23 已消除 JS 堆拷贝(`getFile()` 磁盘背书 File),但 OS 层整载绕不开
- **用户诉求**:先选目标文件夹 → 再把选中的多个文件**分块流式拷贝**进文件系统,峰值内存 = 块大小,不接受整载内存
- **平台事实**(2026-08 核实):
  - iOS Safari 全系**无文件夹选择器**(`showDirectoryPicker`/`showSaveFilePicker` 不支持,WebKit 官方立场 oppose,安全原因)——「先选文件夹」在纯网页版物理不可行
  - Safari 26 新增的「File System WritableStream API」只是 OPFS 可写流补全(`FileSystemFileHandle.createWritable` + `FileSystemWritableFileStream`),**不是 picker**
  - WKWebView 内 OPFS 可用(同 WebKit);但 **Service Worker 在 Capacitor/WKWebView 中不可用**(非 http(s) scheme 限制),离线由本地打包资源承担,与 PWA 缓存语义不同
  - 原生侧:`UIDocumentPickerViewController(forOpeningContentTypes: [.folder])` 可选文件夹 → security-scoped URL → `startAccessingSecurityScopedResource()` 授权读写;会话内可写多个文件

## 考虑过的选项(被拒)

1. **网页版内改进 share(如分块分享)**:不可行——iOS share 只接受 File,OS 序列化整载,网页无 API 可控制
2. **保持现状(share + 下载)**:内存问题无解,大文件分享仍可能崩溃——本 ADR 即为解此问题而存在
3. **原生重写(iOS Swift 应用,不复用 Web)**:丢失全部现有 WebRTC/协议/UI 代码,工作量不成比例;Capacitor 壳复用同一套代码,仅新增桥
4. **Android 同步做**:SAF 选文件夹是另一套桥,范围膨胀——iOS 先行,Android 单独排期

## 决策

1. **修订约束「不做原生应用」(iOS 部分)**:iOS 增加 **Capacitor 8 打包壳**(同一套 React/TS Web 代码,经 WKWebView 承载);桌面/网页版形态不变(仍是 PWA)。原约束理由为「App Store 付费 + 开发版签名时限」,本方案接受个人免费签名 7 天重签的代价,换取向「文件」App 的原生导出能力
2. **iOS app 导出主路径 = 「导出到文件夹…」**:`UIDocumentPickerViewController(.folder)` 选文件夹(一次,会话内有效)→ 保持相对路径逐段建目录 → OPFS 磁盘背书 File 的 `stream()` 分块(**默认 4 MiB**)经 JS↔原生桥逐块写(原生 `NSFileHandle`),**峰值内存 = 块大小**;目录树原生还原,无需 zip。单文件/分组/多选导出在 app 内统一走此路径
3. **分享面板降级为次级按钮**:经 `@capacitor/share` 插件(`navigator.share` 在 WKWebView 不可靠),保留「发到微信/其他 app」用途
4. **v1 不持久化文件夹授权**:每次导出重新选择(透明、无残留授权);security-scoped bookmark 持久化为 **v2** 增强
5. **范围**:iOS 先行;Android(SAF)后续单独评估;桌面 Chrome/Edge 维持 FSA 直写(现有 `fsaExport.ts` 不动)

### 次要默认值(v1,如与预期不符反馈调整)

- **重名冲突**:复用现有 `uniqueZipPaths` 逻辑——追加序号,不覆盖
- **进度/取消**:每个文件独立进度条;取消 = 停止当前文件,已写文件保留,不清理
- **最低 iOS**:OPFS 需求(iOS 15.2+)与 Capacitor 支持范围取交集;目标设备 iOS ≥ 17(与现有约束一致)
- **数据迁移**:网页版 OPFS 数据不迁移(v1 提示用户重新接收);迁移方案不做

## 后果

- 正面:
  - 导出内存有界(峰值 = 4 MiB 块),大文件不再崩溃
  - 一次选文件夹,多个文件顺序分块写入,目录树原生还原
  - 网页版体验不受影响(壳只影响 app 内导出路由)
- 负面 / 边界:
  - **前置:Xcode**（已装 2026-08-16，Xcode 16.4；开发团队 `TJ5797TJ3N` 已配置进 pbxproj）;个人免费签名 7 天过期需重签（`bash scripts/ios-deploy.sh` 一键重签，README.md 有说明）
  - 字节仍过 JS↔原生桥,**非零拷贝**,但分块流动使峰值有界
  - **SW 在 Capacitor 不可用**:离线缓存语义改变(资源随包),spike 的 SW 流式下载逻辑在 app 内无意义;vite-plugin-pwa 注入需对 app 构建禁用（已实现：LT_APP_BUILD=1 时 vite 配置替换为 stub，app 产物无 sw.js、不注册）
  - OPFS 数据不随 app 迁移(存储分区不同;设置页已加提示)
  - ~~待真机验证~~ **已验（2026-08-16，见下）**:WKWebView 内 `createSyncAccessHandle`(接收写入路径)行为、桥吞吐、选文件夹写入

## 验证结论(2026-08-16,prototype/ios-app-spike,iPhone 11 真机)

- **探针 A**(WKWebView worker 内 `createSyncAccessHandle`):通过 — 128MiB 写入无异常无崩溃,**729 MB/s**(远高于阈值)→ 接收写入路径(现有 storage worker)进壳无改动风险
- **探针 B**(4/8/16 MiB 分块过桥):**4MiB 177 / 8MiB 146 / 16MiB 135 MB/s** → 块越小越快,**4 MiB 块大小确认**(与默认一致);桥+落盘本身无瓶颈;JS 侧 base64 编码为真实瓶颈(4MiB 编码 61ms ≈69MB/s,端到端 ≈49 MB/s,10GB ≈3.5 分钟;正式插件用 FileReader/worker 编码优化,标 [v2])
- **探针 C**(`UIDocumentPicker(.folder)` + security-scoped 写入):通过 — 测试文件落进「文件」App 用户所选文件夹(File Provider Storage 路径确认 Files 集成可见)
- **桥参数契约**:Capacitor 桥**不自动转换 TypedArray**(只转 Blob)→ 二进制必须 JS 侧显式 base64 或 Blob
- spike 完整记录:`spike/ios-app/RESULTS.md`(原型分支 `prototype/ios-app-spike`,提交 657291f)
