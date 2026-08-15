# T19: 文件夹导出均衡压缩 + 自定义目标文件夹（两端一致）

- 状态：✅ 代码完成（`npm test` 358/358；build + lint ✓）
- 阻塞：无（T18 已部署）
- 被阻塞者：无
- 引用：SPEC §4（导出）；T18（文件夹发送/zip 导出先例）；`src/transfer/zip.ts`（重写为 fflate deflate）；`src/transfer/fsaExport.ts`（新增）
- 来源：2026-08-15 访谈（用户：iPhone 发到电脑没压缩而手机正常、要求两端一致 + 自定义批量导出到指定文件夹 + 保留单独保存文件）
- 完成备注：zip 由 store 改为 fflate deflate level 6（worker 异步）；新增「导出到文件夹…」（桌面 FSA）；`unzip -t` + Python zipfile 回读验证压缩 zip（deflate type 8、中文名 OK）

## 目标

1. **两端一致的压缩**：接收端 zip 导出从「store 不压缩」（T18 用户拍板）改为 **deflate 均衡压缩（fflate level 6）**——速度与压缩率兼顾；手机（分享）与桌面（分享或下载，无分享能力自动降级）行为一致，不再出现「电脑拿到不压缩包」
2. **自定义批量导出到指定文件夹**：桌面 Chrome/Edge 用 File System Access `showDirectoryPicker` 选目标目录 → 按相对路径逐段建目录写入文件树（`fsaExport.ts`），无需解压即还原目录结构；手机端用「导出 zip → 分享到「文件」App 选位置」对齐
3. **保留现有功能**：逐文件「导出（分享）/下载到本机」、批量分享、zip 分享/下载全部保留

## 验收标准（done when）

- [x] zip 使用 deflate level 6（`ZIP_LEVEL`）：可压缩内容 zip 显著小于原文（单测 >3x），不可压缩内容（真随机）体积持平（开销 <2KB）；`unzip -t` / Python zipfile 回读通过（deflate type 8 + 中文 UTF-8 名）
- [x] zip 打包走 fflate worker 异步 `zip`（1GiB 级不冻结主线程/UI）；单条目 ≤4GiB、路径安全、重名预检不变（`assertZipEntries`）
- [x] 「导出 zip」按钮智能路由：`CAN_SHARE_FILES`（navigator.share + canShare(files) 探测）为真 → 分享；为假（如桌面 macOS Chrome）→ 自动下载，两端行为一致
- [x] 「导出到文件夹…」按钮仅 `showDirectoryPicker` 可用时显示（桌面 Chrome/Edge）：选目标目录 → 逐文件 `createWritable` 写入、逐段建目录保留结构；导出消息含目标名与文件数
- [x] 「批量分享」仅 `CAN_SHARE_FILES` 时显示；逐文件导出按钮不变
- [x] 组总大小 >1GiB 守卫不变（zip/导出到文件夹/批量分享三处统一提示）
- [x] `npm test` 全量绿（358/358：zip 测试重构为压缩断言 + unzipSync 回读）；build + lint ✓
- [ ] **真机待验**：iPhone → Mac：电脑「导出 zip」下载得到压缩包（体积小于原文件夹）；「导出到文件夹…」选目录后直接得到文件树；iPad 分享到「文件」App 解压还原结构

## 备注

- 压缩库选 fflate（纯 JS、零运行时依赖，随 PWA 打包，不违反「运行时无互联网」约束）；此前 T18 用户拍板「不压缩直接保存」，本次按新需求改为均衡压缩
- fflate 的 `zip`（worker 版）回调产出为全新 ArrayBuffer 支撑数组，Blob 直接引用；`unzipSync` 用于单测回读
- 桌面 macOS Chrome 无 `navigator.share`（或 canShare(files)=false）→ 「导出 zip」自动降级下载，不弹「导出失败」；手机 Safari/Android 走分享
- 与 T18 共享：目录分组 `groupTopLevel`、批量分享 `shareNames`、守卫 `ZIP_TOTAL_GUARD_BYTES`、`readMergedOf` 复用
