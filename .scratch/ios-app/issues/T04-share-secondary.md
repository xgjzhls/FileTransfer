# T04: 分享降级为次级按钮(@capacitor/share)

**状态:** ✅ 代码完成（2026-08-16）；壳内分享面板真机项随 T05

**完成记录:**
- 壳内（IS_NATIVE）分享全部切 @capacitor/share：`src/native/share.ts`（writeTemp 落临时文件 → Share.share，iOS files 参数需 file:// URL）；失败有降级提示（message 报错）
- 「下载到本机」壳内 = 分享面板选「存储到文件」（WKWebView 无可靠 a.download）
- UI 层级：单文件 / 目录组 / 多选勾选，app 内「导出到文件夹…」为主、分享为次级按钮
- 桌面/web：navigator.share / FSA 路径零改动（IS_NATIVE 门控）

**验收对照:**
- [x] 壳内分享面板（单文件/批量走 shareFilesNative）；失败降级提示
- [x] app 内主/次级按钮层级正确
- [x] 桌面/web 零改动；`npm test`/build/lint 全绿

**阻塞:** T01

**被阻塞者:** T05

**引用:** ADR-0008(决策 #3:navigator.share 在 WKWebView 不可靠,分享面板降级为次级出口)

## What to build

壳内保留「分享到微信/其他 app」的出口,但改用 @capacitor/share 插件(navigator.share 在 WKWebView 中不可靠);UI 上分享按钮降为次级(主路径是 T03 的导出到文件夹)。桌面/web 路径零改动。

## 方案

- 壳内(native 平台)分享调用切换到 @capacitor/share;失败/不支持时降级提示
- UI 层级调整:app 内「导出到文件夹…」为主,分享为次级
- web/桌面:保持现有 navigator.share / FSA 路径不动

## 验收标准(done when)

- [ ] 壳内分享面板可用(单文件/批量),失败有降级提示
- [ ] app 内主/次级按钮层级正确
- [ ] 桌面/web 路径零改动,回归全绿
