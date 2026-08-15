/**
 * OPFS 容量探测 worker（SPEC §4 容量预警 —— iOS estimate() 恒 0 的替代）。
 *
 * WebKit/iOS 只实现 createSyncAccessHandle（须在 Worker 内），与
 * spike/opfsWorker.ts 同模式：步进写 `capacity-probe.bin` 直到目标大小
 * 或失败点，成功后立即删除并回报「最后成功字节」。
 *
 * 语义：**写失败（含 QuotaExceededError）= 正常结果** —— 失败点即真实
 * 可用上限（iOS OPFS 配额 ≈ 设备剩余空间，spike 实测），以 availableBytes
 * 回报（不设 error）。仅 getDirectory / createSyncAccessHandle 失败
 * （OPFS 不可用等环境错误）才报 error。
 */

import { planProbeBytes, probeAvailable } from './capacity'

let handle: FileSystemSyncAccessHandle | null = null

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  if (!msg || msg.type !== 'start') return
  const { targetBytes, stepBytes, capBytes } = msg

  let availableBytes = 0
  let error: string | null = null
  let root: FileSystemDirectoryHandle | null = null

  try {
    root = await navigator.storage.getDirectory() // 环境错误 → error
    const fileHandle = await root.getFileHandle('capacity-probe.bin', { create: true })
    handle = await fileHandle.createSyncAccessHandle() // 环境错误 → error
    const plan = planProbeBytes(targetBytes, stepBytes, capBytes)
    // 写失败（QuotaExceededError）= 失败点：正常停止，保留已写字节
    const result = await probeAvailable(
      plan,
      async (at, bytes) => {
        try {
          handle!.write(new Uint8Array(bytes), { at })
          return true
        } catch {
          return false
        }
      },
      async () => {
        try { handle?.close() } catch { /* ignore */ }
        try { await root?.removeEntry('capacity-probe.bin') } catch { /* ignore */ }
      },
    )
    availableBytes = result.availableBytes
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    // 环境错误路径也可能已创建文件：尽力清理
    try { handle?.close() } catch { /* ignore */ }
    try { await root?.removeEntry('capacity-probe.bin') } catch { /* ignore */ }
  }

  postMessage({ type: 'done', availableBytes, error })
}
