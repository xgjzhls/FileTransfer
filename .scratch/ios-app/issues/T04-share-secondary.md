# T04: 分享降级为次级按钮(@capacitor/share)

**状态:** ready-for-agent

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
