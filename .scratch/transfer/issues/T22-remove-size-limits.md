# T22: 解除导出/预检大小上限（不设限制）

- 状态：进行中
- 阻塞：无
- 被阻塞者：无
- 引用：SPEC §4（1 GiB 导出守卫、2 GiB 探测上限）；`src/transfer/folderExport.ts`（`ZIP_TOTAL_GUARD_BYTES`）；`src/storage/capacityCheck.ts`（`PROBE_CAP_BYTES`）；`src/storage/capacity.ts`（`interpretCapacity` 超上限文案）
- 来源：2026-08-15 用户口头需求——「怎么回事 怎么给我做了一个1GB还是2GB的分享限制？给我解除掉，不要设置上限」

## 背景

发送/接收（WebRTC 传输）本身一直无大小限制。用户看到的「1GB/2GB 上限」是接收端两处：

1. **1 GiB 导出守卫**（`ZIP_TOTAL_GUARD_BYTES`）：文件夹/多选导出 zip、导出到文件夹、批量分享时组总大小 > 1 GiB 直接拦截并提示「超过 1GiB 打包上限」。导出到文件夹（FSA）本就逐文件写盘，此守卫属多余；zip/批量分享需整组读入内存，守卫原是 iOS 内存保护。
2. **2 GiB 探测封顶**（`PROBE_CAP_BYTES`）：iOS 接收前 OPFS 写探测封顶 2 GiB，超限时提示「已验证至少 2.00 GB 可写…iOS 限制无法精确预检」——只提示、从不阻断，但文案像「上限」。

## 目标（用户已确认「全部解除」）

- 导出不再有 1 GiB 硬拦截（zip / 导出到文件夹 / 批量分享 / 多选导出均不设大小上限）。
- 2 GiB 探测封顶保留为「预检省时」的内部设计（为超大文件全量写盘预检反而慢），但文案改为不再像「上限」，明确「传输本身不设大小上限」。
- 已知边界（非本次改动）：zip32 单条目 > 4 GiB 无法打包（fflate 库/格式限制，已抛错提示逐文件导出）。

## 验收标准（done when）

- [ ] `src/transfer/folderExport.ts` 移除 `ZIP_TOTAL_GUARD_BYTES`；`Home.tsx` 移除 4 处守卫拦截 + `guardSelectedBytes` 及 3 处调用
- [ ] `capacity.ts` 超封顶文案改为说明性（含「传输本身不设大小上限」），不再出现「上限/限制」措辞
- [ ] SPEC.md / CONTEXT.md 同步更新
- [ ] `npm test` 全量绿；lint + build ✓；docs/ 部署产物刷新
