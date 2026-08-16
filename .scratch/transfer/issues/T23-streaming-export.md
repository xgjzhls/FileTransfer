# T23: 导出路径流式化（零拷贝/流式，解除 ~700MB 内存爆）

- 状态：✅ 代码完成（`npm test` 389 全绿 + build + lint ✓；docs/ 已刷新；真机验证待做）
- 阻塞：T22（已解除大小守卫，本票让大导出不再爆内存）
- 被阻塞者：无
- 引用：SPEC §4（导出三式 + 多选导出）；`src/pages/Home.tsx`（`exportFile`/`exportFolderZip`/`exportFolderToDir`/`exportFolderShare`/`exportSelectedZip`/`exportSelectedToDir`/`exportSelectedShare`/`readMergedOf`）；`src/transfer/zip.ts`（`buildZip` 全内存）；`src/storage/engine.ts`（`readMerged`→`readAll` 整载）
- 来源：2026-08-15 用户——「即使放开限制，可能也会因为内存爆了 导致无法一次分享太多文件 大约700M」；已确认走「先修 Web 流式导出」

## 根因

传输/接收/拼接全程流式（chunk 写 OPFS、merge 1 MiB 缓冲），内存平稳。
爆内存只在**导出路径**：`readMergedOf` → `adapter.readMerged` 把整文件读进 JS 堆
（`readAll` 分配 `size` 字节）；`buildZip` 整包驻留；批量分享 N 个 File 全量驻留。
700MB 多文件分享 ≈ 700MB+ JS 堆 ×2~3（文件数据 + zip 输出），iOS 直接崩。

## 方案（主线程 OPFS 异步 API，worker 只保留接收写入）

OPFS 是 origin 级共享：worker sync handle 写入的文件，主线程 async API
（`navigator.storage.getDirectory()` → `getFileHandle().getFile()`）可直接读，
`File` 磁盘背书（O(1) 不拷贝）、`file.stream()` 流式读、`createWritable()` 流式写。

1. **新模块 `src/storage/opfsExport.ts`**：`opfsMergedFile(sessionId, fileId, name)` →
   OPFS 异步句柄 `getFile()` 返回磁盘背书 File（merge 前置仍在 worker 流式执行）。
2. **单文件导出 `exportFile`**：`merge`（流式）→ `opfsMergedFile` → objectURL 下载 /
   `navigator.share`（零拷贝）。删 `readMergedOf` 全量读。
3. **批量分享**：N 个磁盘背书 File 一次进分享面板，JS 堆不再驻留 N×size。
4. **zip 导出（文件夹/多选）**：新 `buildZipStream` —— fflate 流式 `Zip`/`ZipDeflate`
   （level 6 不变），`file.stream()` 分块喂入，输出 chunk 写 OPFS 临时 zip（`createWritable`
   流式，带背压）→ `getFile()` → 分享/objectURL 下载。桌面/手机同路径，UX 不变。
   保留 `assertZipEntries`（安全路径 + 4GiB 单条目 + 重名）。
5. **导出到文件夹（桌面 FSA）**：`file.stream()` → `createWritable()` 管道，逐文件流式写。
6. **降级**：OPFS 异步不可用（罕见）→ 回退现有 `readMerged` + `buildZip` 全内存路径。

## 验收标准（done when）

- [x] `opfsExport.ts`：`opfsMergedFile` 走 OPFS 异步句柄返回磁盘背书 File（可注入根句柄便于测试）
- [x] `buildZipStream` 自写流式 zip 写入器（本地头 + 数据描述符 + 中央目录 + 自带 CRC-32；fflate 流式 Deflate/AsyncDeflate；ondrain/链式背压；同步阈值 4MiB）；node 单测用 `unzipSync` 校验内容/结构/UTF-8 名/4GiB 断言/crc32 向量
- [x] Home.tsx 六条导出路径 + `exportFile` 全部走流式（`mergedFileOf` = merge + `opfsMergedFile`）；`readMergedOf` 整载读已移除
- [x] 降级说明：OPFS 异步（Safari 15.2+/Chrome 86+）是应用接收能力的硬前置，无需旧全内存路径；不可用时清晰报错
- [x] `npm test` 全量绿；lint + build ✓；docs/ 刷新
- [ ] 真机验证（备注）：iOS Safari 18.4+ 分享 ~700MB 多文件 / 大单文件；桌面 Chrome 大 zip 导出

## 备注

- 真机待验证点：Safari `navigator.share` 对 OPFS 背书 File 的超大单文件 OS 级上限
  （值随版本变）；分享面板文件数上限。若遇 OS 级墙再评估 Capacitor（T-未来）。
- fflate v0.8.3 流式类确认：`Zip` 类对单条目会整条缓冲（chks_1），不适合大文件，
  故自写 zip 写入器（T23 结论）；`Deflate` 同步回调签名 (data, final) 无 err 参数。
- `AsyncDeflate` 会 transfer 输入块 buffer：生产 File.stream() 每块独立分配无影响；
  测试流按 Blob.stream() 语义逐块拷贝。
- OPFS exports/ 临时 zip 随设置页清理（removeAll 全根）一并删除。
