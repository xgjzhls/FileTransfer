# T02: 存储层 —— OPFS 读写 + 清理

- 状态：待实现
- 阻塞：T01
- 被阻塞者：T05
- 引用：SPEC §4；ADR-0005；spike 验证结论（sync access handle 是 iOS 唯一写入 API；estimate() 恒为 0；每浏览器分区隔离）

## 目标
接收端文件存储能力：Worker 内 OPFS 随机读写（`createSyncAccessHandle` + `{at}`）、part 文件管理、拼接、孤儿数据清理。

## 验收标准（done when）
1. StorageAdapter 接口：`open(sessionId, fileId, partIndex)` / `writeChunk(offset, bytes)` / `readPart` / `finalizePart(校验)` / `merge(parts → 单文件)` / `deleteAll`
2. 全部写操作走 Web Worker（sync handle 不能在主线程；主线程按 chunk postMessage 递数据）
3. OPFS 布局符合 SPEC §4（`sessions/<sessionId>/<fileId>/part-<index>.bin` + 拼接文件）
4. 清理：设置页「清除全部数据」删除整个 OPFS 根 + IndexedDB；启动时扫描孤儿（无 manifest 或超 30 天）并提示
5. 单测（Vitest）：chunk 写入偏移正确、part 拼接后 SHA-256 与源一致、清理幂等
6. 真机复测：iPhone 上写入 1GB+ 文件并拼接成功（复用 spike 页）

## 备注
- 依赖 TS7 缺失类型的本地声明（从 spike 分支 `fs-sync-access.d.ts` 迁入）
- 不要用 `navigator.storage.estimate()` 判断容量（iOS 恒 0）
- manifest/bitfield 持久化属 T06，本票只做数据读写与清理
