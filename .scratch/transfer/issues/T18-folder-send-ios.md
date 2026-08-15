# T18: 手机/iPad 选文件夹发送 + 接收端目录结构保持导出（webkitdirectory + zip/批量分享）

- 状态：✅ 代码完成（`npm test` 355/355；build + lint ✓；e2e 24/24（降级））
- 阻塞：无
- 被阻塞者：无
- 引用：SPEC §6.3（文件夹发送）、SPEC §4（导出）；`src/transfer/dirPicker.ts`（桌面 showDirectoryPicker 先例）；`src/transfer/zip.ts` / `folderExport.ts`（新增）
- 来源：2026-08-15 访谈（用户：iPad/手机直接点文件夹，子目录与文件一起传，保持目录结构到目标手机）
- 完成备注：新增 20 单测（dirPicker webkit 5 / zip 9 / folderExport 7）；zip 经真实 `unzip -t` + Python zipfile 回读验证（含中文名 UTF-8）

## 目标

两条链路补齐「手机上发文件夹、目标机还原目录结构」：

1. **发送端（iOS Safari 18.4+ / Android Chrome）**：`<input type=file webkitdirectory>` 选文件夹 → 浏览器递归返回目录树 File[]，`webkitRelativePath` 去首段得到与桌面 `walkDirectory` 一致的相对路径 → 复用现有发送/续传管线（name=相对路径，接收端 OPFS 按段建目录）
2. **接收端导出（结构保持）**：接收文件按顶层目录分组，提供「导出 zip（store 不压缩，目录结构 100% 保留，目标端「文件」App 原生解压）」与「批量分享（全部文件一次进分享面板，收进目标文件夹，子目录拍平）」

## 验收标准（done when）

- [x] 发送端「选择文件夹」按钮：`showDirectoryPicker`（桌面 Chrome/Edge）或 `webkitdirectory`（iOS 18.4+ / Android Chrome / 桌面 Chrome）任一支持即显示；都不支持（iOS <18.4）隐藏按钮并提示「选文件夹需 iOS 18.4+…可多选文件」（`CAN_PICK_DIR`）
- [x] webkitdirectory 路径：递归子目录文件全部进入发送队列，`relName` 为相对路径（`照片/2024/img.jpg`，去掉选中文件夹名首段）；路径不安全条目（isSafeRelPath 拒绝）记入 skipped 并提示；与桌面路径产出同构（同一 `buildSendItems`）
- [x] 接收端：文件夹发送（name 含 `/`）按顶层目录分组显示「📁 dir/（N 个文件 · 总大小）」，全部完成前显示「x/N 完成」不提供导出按钮
- [x] 「导出 zip」：store-only zip（`zip.ts`，零依赖，UTF-8 文件名 + CRC-32 + 中央目录 + EOCD），目录结构保留；分享或下载；单条目 >4GiB / 路径不安全 / 重名 → 明确报错
- [x] 「批量分享」：组内全部文件一次 `navigator.share`，basename 命名、重名父目录前缀消歧（`shareNames`）
- [x] 内存守卫：组总大小 >1GiB（`ZIP_TOTAL_GUARD_BYTES`）→ 提示分批/逐文件导出，不静默崩溃
- [x] 单测全量绿（355/355，新增 20）；zip 经真实 `unzip -t`/Python zipfile 回读（含中文名）；build + lint ✓；e2e 24/24（降级，本机 ICE 不可达按文档降级）
- [ ] **真机待验（T08 类）**：iPad/iPhone（iOS ≥18.4）选文件夹 → 传至目标手机 → 导出 zip → Files 解压还原目录结构；批量分享收文件夹体验；iOS 17.x 降级提示

## 备注

- `webkitdirectory` 是 IDL 属性，用 ref 挂载后置位（`el.webkitdirectory = true`），JSX 属性方式不可靠
- 桌面 Chrome 维持 showDirectoryPicker 路径（有 `dirHandle.name` 展示），webkitdirectory 覆盖其余支持者（Android Chrome 一并受益）
- zip 只做 method=0 store（用户拍板「不压缩」）：照片/视频已压缩无差、更快；文本/文档类 zip 偏大可接受
- zip32 单条目上限 4GiB：>4GiB 的单文件（项目上限 10GB）不打包，提示逐文件导出；zip64 不在 v1
- 导出文件名的 `name` 均为安全相对路径（发送端 dirPicker / 接收端 engine 双重 isSafeRelPath 校验），zip 条目路径复用同一校验（assertZipEntries）
