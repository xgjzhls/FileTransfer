# T05: chunk 传输 + part 校验 + 导出

- 状态：✅ 代码完成（含性能优化：背压事件化 + 零拷贝写盘，300MiB 实测 30 MiB/s）；⚠️ 验收 6（1GB+ SHA-256 一致 + iPhone 真机）待用户设备
- 阻塞：T02, T04
- 被阻塞者：T06, T08
- 引用：SPEC §3.1/§3.2/§4；ADR-0005
- 完成备注：`npm test` 118/118；e2e 6/6（E2E_NO_PROXY=1）；chunk 256KiB 为 DataChannel maxMessageSize 硬上限（SPEC 已注）；导出支持分享 + 下载到本机

## 目标
真正的数据传输：文件切 part/chunk 发送，接收端落盘、校验、拼接、导出（文件/照片门控）。

## 验收标准（done when）
1. 发送端：文件按 512MiB part / 1MiB chunk 分块；`bufferedAmount` 背压（>8MiB 暂停排程）；一次一个文件顺序队列
2. chunk framing：`[type=0x01][fileId u32][partIndex u32][chunkIndex u32][payload]`；控制消息 `0x00` JSON（meta/part_done/file_done/bye/error/cancel）
3. 接收端：worker 按偏移写 OPFS（T02）；part 收齐读回整体 SHA-256 校验 → `part_done`；失败该 part 重传（本票先整 part 重传，bitfield 属 T06）
4. 导出：拼接单文件 → Web Share：`image/*|video/*` 且 <300MiB 显示「存到照片」；其余/更大显示「存储到文件」+ Files 导入提示
5. 批量队列 UI：文件列表、逐 part 进度、取消/重试
6. 验收测试：桌面 Chrome 对 Chrome 传输 1GB+ 文件，SHA-256 与源一致；iPhone 真机传 1GB（复用 spike 存储能力）

## 备注
- 元数据先行：meta 里带完整 part 清单（含 sha256），接收端确认后才开传
- 存照片阈值 300MiB 为配置常量（PHOTO_GATE_BYTES），后续按真机实测调整
