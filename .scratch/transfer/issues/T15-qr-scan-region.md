# T15: 扫码不识别 —— 扫描区裁掉定位角（真机：码在框内但永不识别）

- 状态：✅ 代码完成（扫描区 2/3 → 95% + 可见取景框 + 提示文案；5 新单测 + 伪造摄像头回归回路验证）
- 阻塞：无
- 被堵者：无
- 引用：SPEC §5.3；T07 / T13（离线 QR 配对现状）
- 来源：2026-08-15 真机反馈「手机扫码：码在框内但不会自动识别，一直停在摄像状态，无法获取信息」
- 完成备注：`npm test` 315/315（新增 src/qr/qrScan.test.ts 5 测）；build/lint ✓；scripts/qr-fakeloop.mjs 回归回路：修复前 >66% 必失败、修复后 92% 在 ~10ms 内解码（Chromium 原生引擎与 jsQR 双引擎验证）

## 根因（回路确认）

qr-scanner 默认 `_calculateScanRegion` 只解码**视频中心 2/3 正方形**，且降采样到 400×400。
二维码一旦大于该区域（用户把码放进取景框的自然动作——码充满画面），裁剪区里只剩码的
中间，**三个定位角（finder pattern）被裁掉 → 任何引擎（BarcodeDetector / jsQR）都无法识别**，
表现为「码在框内但永不识别、一直摄像状态」。

证据（scripts/qr-fakeloop.mjs，真实应用 + 伪造摄像头 y4m 驱动完整管线）：
- 码占帧高 50% / 66% → 15ms 解码 ✅（修复前后均如此）
- 码占 100%（充满）→ 30s 永不识别 ❌（修复前）
- 修复后 70% / 80% / 92% → ~10ms 解码 ✅（92% 已接近充满；100% 贴边零边距为测试台架人工边缘，真实场景由取景框引导避免）

排查过程中排除的假设（防后人重复踩坑）：
- ~~码太密/分辨率不足~~：页面内两个引擎在 400px 及更低分辨率均能解真实 offer 码（200px 也能）
- ~~iOS 原生 BarcodeDetector 问题~~：iOS Safari 17.0–26.x 该 API 默认禁用（caniuse），实际走 jsQR worker
- ~~复用 canvas 导致 BarcodeDetector 返回过期结果~~：像素级比对（diffPixels=0）证明 canvas 内容每帧更新；「复用 10 次全失败」实为内容不可解的假象

## 修复

1. `src/qr/qrScan.ts`：自定义 `calculateScanRegion` —— 中心 **95%** 正方形（`SCAN_REGION_RATIO=0.95`），
   且省略 `downScaledWidth/Height`（画布 = 区域原尺寸，优于默认 400px 降采样，对密集码/远处小码更宽容）
2. `highlightScanRegion: true` —— 取景框可见，用户知道码要放进哪个区域
3. `OfflinePair.tsx` scan-wait 提示文案：「把二维码完整放入取景框，码的边缘留出边距，不要贴太近」
4. `calcScanRegion` 抽纯函数 + 5 单测（比例 ≥90%、覆盖接近充满的码、中心对称、退化输入）
5. `scripts/qr-fakeloop.mjs`：回归回路固化（伪造摄像头 y4m 驱动真实应用完整扫码管线，断言解码）

## 验收标准（done when）

- [x] 定位到根因（扫描区裁剪），用回路复现并最小化（100% 红 / 66% 绿，双引擎）
- [x] 扫描区 2/3 → 95% 且不降采样；取景框可见；提示文案就位
- [x] `calcScanRegion` 纯函数单测 5 条；`npm test` 全量绿；build/lint 通过
- [x] 回归回路（scripts/qr-fakeloop.mjs）修复前 66% 内可解 / 修复后 92% 可解，双引擎验证
- [x] 插桩清理：`[LOOP-qr]`/`[DEBUG-qr]`/`?jsqr=1` 全部移除（grep 确认）
