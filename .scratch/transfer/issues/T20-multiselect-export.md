# T20: 接收多选批量导出（跨组勾选 → 导出到文件夹 / zip / 批量分享）

- 状态：✅ 代码完成（`npm test` 368/368；build + lint ✓；双轴评审已过，遗留项见备注）
- 阻塞：无（T19 已部署）
- 被阻塞者：无
- 引用：SPEC §4（导出）；T19（分组导出先例：uniqueZipPaths / shareNames / fsaExport / ZIP_TOTAL_GUARD_BYTES）；`src/pages/Home.tsx`（接收区 UI）；`src/transfer/folderExport.ts`
- 来源：2026-08-15 访谈（用户：保留现有全部功能，另加「多选批量导出到指定文件夹」）。四个决策点已拍板：①复选框多选跨组勾选 ②手机端（无 FSA）选中项打包 zip 分享到「文件」App ③保持相对路径 ④三种批量操作全要（导出到文件夹…/导出选中 zip/批量分享选中）

## 目标

接收区给已完成文件加复选框，可跨顶层目录组勾选任意文件，勾选后提供三种批量导出：

1. **导出选中到文件夹…**（桌面 FSA）：`showDirectoryPicker` 选目标目录 → 保持相对路径写入（`photos/a.jpg` → 目标目录下 `photos/a.jpg`；根目录散文件直接放目标根），无需解压
2. **导出选中 zip**（跨组打包）：deflate level 6（fflate worker），目录结构保留；分享（仅移动端）/ 下载（桌面）路由与分组 zip 完全一致
3. **批量分享选中**（手机）：`shareNames` 消歧，一次进分享面板（子目录拍平）

现有逐文件导出（导出/下载到本机）与分组导出（导出 zip / 导出到文件夹… / 批量分享）全部保留不动。

## 验收标准（done when）

- [x] 接收列表每行（`status === 'done'`）有复选框；receiving 行不显示复选框
- [x] 勾选后工具栏显示：「已选 n 项（总大小）」+ 导出选中到文件夹…（仅 `HAS_FSA_PICKER`）/ 导出选中 zip / 批量分享选中（仅 `CAN_SHARE_FILES && !HAS_FSA_PICKER`）/ 全选 / 清空
- [x] 跨组勾选去重正确（单测锁定）：`photos/a.jpg` + `docs/a.jpg` + 根目录 `a.jpg` 互不冲突（全路径去重）；同名条目（两个根目录 `IMG_0001.JPG`）zip/目录导出追加序号、批量分享 basename 消歧
- [x] 「导出选中到文件夹…」保持相对路径；新会话（onMeta）自动清空勾选；勾选随接收进度实时反映（receiving → done 后可勾）
- [x] 选中总大小 >1GiB 统一守卫提示分批（与分组导出文案对齐：请分批或逐文件导出）
- [x] zip 名「选中文件.zip」；消息文案与分组导出对齐
- [x] `npm test` 全量绿（368/368：`sumBytes` + `disambiguateRootVsDir` + 跨组去重用例）；build + lint ✓
- [x] 根散文件 vs 目录首段同名冲突消歧（评审修正）：`disambiguateRootVsDir`——目录优先、散文件追加序号，FSA 导出不会建文件/建目录同名抛错（`photos` 文件 + `photos/` 目录组共存）
- [ ] **真机待验**：桌面「导出选中到文件夹…」选目录后直接得到文件树；iPhone「导出选中 zip」分享到「文件」App 解压还原结构；勾选含根散文件与同名目录组的场景

## 备注

- 纯函数复用：`uniqueZipPaths`（按条目对象键、全路径去重，跨组天然正确）/ `shareNames` / `writeFileTree` / `ZIP_TOTAL_GUARD_BYTES` 沿用；新增 `sumBytes` 守卫辅助（避免三处重复 reduce）与 `disambiguateRootVsDir`（跨组 FSA/zip 导出的根散文件 vs 目录名冲突消歧，含同全路径去重）
- 选择状态存组件 state（`Set<id>`），派生 `selectedItems = recvItems.filter(done && 选中)`——会话重置时旧 id 自动失效，onMeta 显式清空
- 与 T19 共享：zip 分享路由（`CAN_SHARE_FILES && !HAS_FSA_PICKER` → share，桌面/分享失败降级 download）、`readMergedOf` 复用
- **代码评审遗留（不阻塞，留待 T21 / code-health）**：T19 与 T20 的导出三元组（zip / 导出到文件夹 / 批量分享）约 90 行同构重复，可抽参数化核心（items + zipName + 消息文案）；分享降级（NotAllowedError/SecurityError）级联现 4 处。本次未重构：T19 为刚上线且真机待验的代码，组件层无自动化测试，重构风险高于收益。守卫文案漂移已修齐。
