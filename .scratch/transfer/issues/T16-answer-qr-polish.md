# T16: 离线配对打磨 · 回码全屏 + 一键分享（answer 端）

- 状态：✅ 代码完成（回码全屏 min(80vw,360px) + 一键分享 navigator.share + 降级复制；逻辑抽到 shareCode 纯模块）
- 阻塞：无（T07/T13/T14 已完成，可立即开工）
- 被阻塞者：无
- 引用：SPEC §5.3（两跳体验打磨条目「回码全屏」「回码一键分享」）；ADR-0007；T07（离线 QR 配对现状）；T13（answer 端免选角色/扫码打磨）
- 来源：2026-08-15 访谈（Q4 选定条目 a + c；完全离线是主场景，两跳为物理上限，打磨目标是体感接近一扫码）
- 完成备注：`npm test` 335/335（新增 src/qr/shareCode.test.ts 11 测）；build + lint ✓；e2e 24/24（新增 T16 断言：canvas 实际渲染宽 360px > 旧 260px + 「分享回码」按钮存在）

## 目标

离线配对第二跳（手机/接收端拿到 offer 后把回码交回发送端）的体验打磨，两个独立改进：

1. **回码全屏**：answer 端回码二维码从 `maxWidth 260px` 放大到可用屏宽（约 `min(80vw, 360px)`），对方回扫/回拍更容易扫中
2. **回码一键分享**：answer 端新增「分享回码」按钮，把回码文本经 `navigator.share({ text })` 直接分享到微信/文件传输（iOS 支持文本分享），省掉「复制 → 切 app → 粘贴」里的手动复制；不支持/失败时降级为复制

## 验收标准（done when）

- [x] answer-show 页回码二维码放大至可用屏宽（约 `min(80vw, 360px)`，现为 260px），窄屏（手机竖屏）与宽屏均不溢出、可完整扫描
- [x] answer-show 页新增「分享回码」按钮：调用 `navigator.share({ text: <回码文本> })`，iOS 上可分享到微信/文件传输
- [x] `navigator.share` 不可用 / 分享抛错 / 用户取消：不报错中断，降级提示使用「复制配对码」（现有复制功能保留）
- [x] 「分享 vs 复制」的选择逻辑与二维码宽度计算抽到可单测的纯逻辑模块（`src/qr/shareCode.ts`），单测覆盖：支持分享 / 不支持 / 分享失败三种路径（另含 AbortError 取消）
- [x] `npm test` 全量绿（335/335）；e2e（scripts/e2e.mjs）随按钮文案更新（24/24，T16 断言实际渲染宽）；`npm run build` + lint 通过；code-review 双轴通过（Standards 无违规；Spec 无未决项——评审意见已全部落实）

## 备注

- 仅影响 answer-show 相位；offer-show 与 pick 不动（T17 范围）
- 回码文本内容与格式不变（v1 信封，SPEC §5.3），分享只是传输载体变化
- 与 T17 同在 OfflinePair.tsx，建议串行实现（先 T16 后 T17），避免同文件冲突
