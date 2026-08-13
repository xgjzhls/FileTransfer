/**
 * Test 1 — iOS Safari OPFS quota probe.
 *
 * Writes a growing file via OPFS (sync access handles in a worker — the only
 * write API WebKit implements on iOS) until the browser refuses, reporting the
 * largest size it accepted, persist() before/after, and the storage estimate.
 * This answers: "can a 10 GB file be stored on this device inside the origin
 * sandbox?"
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
const CAP = 64 * 1024 * 1024 * 1024 // safety cap: 64 GB

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

  const worker = new Worker(new URL('./opfsWorker.ts', import.meta.url), { type: 'module' })
  const result = await new Promise<{ total: number; error: string | null; hitCap: boolean }>(
    (resolve, reject) => {
      worker.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'progress') {
          onProgress(msg.bytes)
        } else if (msg.type === 'done') {
          resolve({ total: msg.total, error: msg.error, hitCap: msg.hitCap })
        }
      }
      worker.onerror = (e) => reject(new Error(e.message || 'worker error'))
      worker.postMessage({ type: 'start', chunkSize: CHUNK, cap: CAP })
    },
  )
  worker.terminate()

  const durationMs = Date.now() - start
  return {
    opfsAvailable: true,
    persistedBefore,
    persistedAfter,
    estimateBefore: estimateBefore ? { usage: estimateBefore.usage ?? 0, quota: estimateBefore.quota ?? 0 } : null,
    estimateAfter: estimateAfter ? { usage: estimateAfter.usage ?? 0, quota: estimateAfter.quota ?? 0 } : null,
    maxBytes: result.total,
    durationMs,
    mbPerSec: durationMs > 0 ? (result.total / durationMs) * (1000 / 1024 / 1024) : 0,
    error: result.error,
    hitCap: result.hitCap,
  }
}
