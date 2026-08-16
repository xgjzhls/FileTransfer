# T02: 原生文件夹导出插件(正式版)

**状态:** ready-for-agent

**阻塞:** T01

**被阻塞者:** T03

**引用:** ADR-0008 验证结论(spike 实测 2026-08-16);原型分支 `prototype/ios-app-spike`(插件雏形 SpikeBridgePlugin.swift;RESULTS.md 含关键契约:4 MiB 块最优、TypedArray 不被桥自动转换需 JS 显式 base64、security-scoped URL 写入端到端通过)

## What to build

把 spike 验证过的原生桥固化为正式 Capacitor 插件,提供「选文件夹 + 分块写入」四个原语,并带类型化 TS facade。插件本身可独立验收(用探针页在真机上把文件写进用户所选文件夹),T03 在此基础上搭用户流程。

## 方案

- `pickFolder`:UIDocumentPicker(.folder)→ security-scoped URL;一次选择,会话内可写多个文件
- `mkdir`:按相对路径逐段建目录(嵌套)
- `writeChunk`:4 MiB 分块 base64 写入(isFirst/isLast,isLast 返回最终 size;数据来自 JS 侧显式编码——桥不转换 TypedArray)
- `abort`:中断当前文件写入,可清理半成品
- TS facade + 类型;探针/测试页在真机验收

## 验收标准(done when)

- [ ] pickFolder 返回 security-scoped URL,会话内可写多个文件
- [ ] mkdir 按相对路径逐段建目录(含深层嵌套)
- [ ] writeChunk 分块写正确、isLast 返回最终 size;abort 中断并可清理半文件
- [ ] 真机验证:选文件夹 → 写多文件 → 「文件」App 可见(复用 spike 探针页)
- [ ] 插件随 T01 构建链路自动注册(SPM + packageClassList),无需手改原生工程
