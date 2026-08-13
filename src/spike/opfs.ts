/**
 * Test 1 — iOS Safari OPFS quota probe.
 *
 * Writes a growing file via OPFS until the browser refuses, reporting the
 * largest size it accepted, before/after navigator.storage.persist(), and the
 * storage estimate. This answers: "can a 10 GB file be stored on this device
 * inside the origin sandbox?"
 */

export interface OpfsQuotaResult {
  opfsAvailable: boolean
  persistedBefore: boolean
  persistedAfter: boolean
  estimateBefore: { usage: number; quota: number } | null
  estimateAfter: { usage: number; quota: number } | null
  maxBytes: number
  durationMs: number
  mbPerSec: number
  error: string | null
  hitCap: boolean
}

const CHUNK = 64 * 1024 * 1024 // 64 MB per write
const CAP = 128 * 1024 * 1024 * 1024 // safety cap: 128 GB

export async function runOpfsQuotaTest(
  onProgress: (writtenBytes: number) => void,
): Promise<OpfsQuotaResult> {
  const opfsAvailable = 'storage' in navigator && typeof navigator.storage.getDirectory === 'function'
  if (!opfsAvailable) {
    return {
      opfsAvailable: false,
      persistedBefore: false,
      persistedAfter: false,
      estimateBefore: null,
      estimateAfter: null,
      maxBytes: 0,
      durationMs: 0,
      mbPerSec: 0,
      error: 'OPFS 不可用（需要安全上下文 + Safari 15.2+）',
      hitCap: false,
    }
  }

  const start = Date.now()
  const persistedBefore = await navigator.storage.persisted()
  const estimateBefore = await navigator.storage.estimate()
  try {
    await navigator.storage.persist()
  } catch {
    // persist() is best-effort; persistedAfter below is what matters.
  }
  const persistedAfter = await navigator.storage.persisted()
  const estimateAfter = await navigator.storage.estimate()

  let total = 0
  let error: string | null = null
  let hitCap = false
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle('quota-test.bin', { create: true })

  try {
    const writable = await handle.createWritable()
    try {
      while (true) {
        // Fresh buffer per write: never reuse a buffer handed to the writer.
        await writable.write(new Uint8Array(CHUNK))
        total += CHUNK
        onProgress(total)
        if (total >= CAP) { hitCap = true; break }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      try { await writable.abort() } catch { /* ignore */ }
    }
  } finally {
    try { await root.removeEntry('quota-test.bin') } catch { /* ignore */ }
  }

  const durationMs = Date.now() - start
  return {
    opfsAvailable: true,
    persistedBefore,
    persistedAfter,
    estimateBefore: estimateBefore ? { usage: estimateBefore.usage ?? 0, quota: estimateBefore.quota ?? 0 } : null,
    estimateAfter: estimateAfter ? { usage: estimateAfter.usage ?? 0, quota: estimateAfter.quota ?? 0 } : null,
    maxBytes: total,
    durationMs,
    mbPerSec: durationMs > 0 ? (total / durationMs) * (1000 / 1024 / 1024) : 0,
    error,
    hitCap,
  }
}
