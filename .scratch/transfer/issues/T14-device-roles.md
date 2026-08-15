# T14: 离线配对设备分工（电脑出码 / 手机扫码）

- 状态：✅ 代码完成（设备分工默认主路径 + 三步引导 + 电脑端常驻粘贴框；17 新单测 + e2e 随文案更新；已过 code-review 双轴评审）
- 阻塞：无
- 被阻塞者：无
- 引用：SPEC §5.3；ADR-0006；T07 / T13（离线 QR 配对现状）；T11（detectKind 现位于 Home.tsx，本票抽离）
- 来源：2026-08-15 访谈（痛点：「配对很麻烦，还要和 Windows 配对，电脑没法扫码」→ 结论：设备分工——谁有摄像头谁扫码，没摄像头的一方只负责显示/粘贴）
- 完成备注：`npm test` 310/310（src/device.ts 7 测 + src/qr/pairGuide.ts 10 测）；`npm run build` ✓；lint（src/scripts）零告警；e2e 脚本已随新文案更新（未实跑，需 dev server + wrangler 环境）；code-review：Standards 无硬违规、Spec 五项验收全落地，评审建议已吸收（按钮文案抽 `pairButtonLabels`、headline 区分平板、桌面步骤 3 文案修正）

## 目标

离线配对按设备类型分工引导，解决「电脑无法扫码」的离线配对痛点：

- **电脑（desktop，默认无摄像头）**：主路径 = 「显示配对码」（只出码、不扫码）
- **手机/平板（有摄像头）**：主路径 = 「扫码」
- pick 页给出三步引导：电脑显示配对码 → 手机扫电脑屏幕（自动判定角色）→ 手机把回码文本发回电脑（微信/文件传输）粘贴 —— 恰好一轮跨设备传输
- 两向均可手动切换（手机↔手机仍是一台显示、一台扫码；两台电脑走「显示 + 粘贴」）

## 验收标准（done when）

- [x] `detectKind` 从 Home.tsx 抽到共享模块 `src/device.ts`，Home 与 OfflinePair 共用；单测覆盖 phone/tablet/desktop（UA 桩）
- [x] pick 页按设备类型给出默认主路径与三步引导文案（桌面 / 手机各一套）；「显示配对码」「扫码配对」两个按钮都保留、可手动切换
- [x] 电脑端 offer-show 页直接显示回码粘贴框（不再藏进 `<details>`）；answer-show 提示「把回码文本复制发给对端」
- [x] 纯逻辑（`primaryPairAction` / `pairGuide` / `pairButtonLabels`）抽到 `src/qr/pairGuide.ts` 并单测；`npm test` 全量绿
- [x] e2e（scripts/e2e.mjs T13 段）随按钮文案更新（电脑端粘贴框不再藏在 details 后）
- [x] SPEC §5.3 补设备分工说明；`npm run build` + `npm run lint` 通过

## 备注

- 方向性约束不变（T13）：offer 必须先于 answer 存在——「显示配对码」一方即 offer 端；数据流向与握手角色无关，连接后任一端均可发文件
- 「配对文件（.ltpair）导出/导入」是更顺的下一步（T15 候选，本票不做）
