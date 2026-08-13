/**
 * OPFS quota probe worker.
 *
 * WebKit/iOS Safari only implements OPFS sync access handles
 * (createSyncAccessHandle) — createWritable() is NOT a function there.
 * Sync handles must be used inside a worker, which also keeps the main
 * thread responsive during a multi-GB write loop.
 */

let handle: FileSystemSyncAccessHandle | null = null

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  if (!msg || msg.type !== 'start') return
  const { chunkSize, cap } = msg

  const buf = new Uint8Array(chunkSize)
  let total = 0
  let error: string | null = null
  let hitCap = false
  let root: FileSystemDirectoryHandle | null = null

  try {
    root = await navigator.storage.getDirectory()
    const fileHandle = await root.getFileHandle('quota-test.bin', { create: true })
    handle = await fileHandle.createSyncAccessHandle()
    while (true) {
      handle.write(buf, { at: total })
      total += chunkSize
      postMessage({ type: 'progress', bytes: total })
      if (total >= cap) {
        hitCap = true
        break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    try { handle?.close() } catch { /* ignore */ }
    try { await root?.removeEntry('quota-test.bin') } catch { /* ignore */ }
  }

  postMessage({ type: 'done', total, error, hitCap })
}
