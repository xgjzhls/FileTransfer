# T21: 点击二维码放大全屏（点空白处关闭）

- 状态：✅ 代码完成（`npm test` + build + lint ✓；e2e 步骤已加，见备注）
- 阻塞：无
- 被阻塞者：无
- 引用：SPEC §5.3（两跳体验打磨条目）；T16（回码全屏先例：`answerQrMaxWidth`）；`src/pages/OfflinePair.tsx`（offer-show / answer-show 两个二维码）；`src/qr/qrRender.ts`（`renderQrToCanvas` 512px 上限）
- 来源：2026-08-15 用户口头需求——「点击二维码时展示超大的全屏二维码，点周围空白处关闭」

## 目标

offer-show 与 answer-show 两个二维码均可点击放大：全屏暗色遮罩 + 居中大码（`min(88vw, 82vh)`），点击码外空白处或按 Esc 关闭。放大后扫码端更容易对准（offer 码现为 260px 上限，手机全屏可到 ~90vw）。

## 验收标准（done when）

- [x] offer-show / answer-show 二维码可点击（cursor: zoom-in，aria-label「点击放大查看二维码」）
- [x] 点击后出现全屏遮罩：`position: fixed; inset: 0`，深色半透明底，白底大码居中，渲染尺寸上限提升（1024px）保证放大后不糊
- [x] 点击码外空白处关闭；按 Esc 关闭；点码本身不关闭（stopPropagation）
- [x] 相位切换 / 面板收起时全屏自动关闭（防止内容与当前相位脱节）
- [x] 全屏打开时锁定 body 滚动
- [x] `npm test` 全量绿；build + lint ✓
- [x] e2e（`scripts/e2e.mjs` T14 段已加步骤；Playwright 真机冒烟已验：全屏 590×590、点码不关、点空白关、Esc 关）

## 备注

- `renderQrToCanvas` 增加可选 `maxSize` 参数（默认 512 不变），全屏调用传 1024 —— 普通展示路径零改动
- 全屏渲染走独立 canvas ref（`fullscreenCanvasRef`），与主码复用同一 `renderQrToCanvas`，仅尺寸上限不同
- 关闭路径统一：`useEffect([phase, open])` 关闭 + Esc keydown + 遮罩点击；不引入新组件/新依赖
