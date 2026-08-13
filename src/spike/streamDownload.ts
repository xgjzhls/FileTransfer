/**
 * Test 2 — SW-streamed download probe.
 *
 * Feeds a synthetic multi-GB stream from the page through the service worker
 * (MessagePort -> ReadableStream -> Response) and triggers a download. If
 * Safari streams the response to the Files app we win; if it buffers the whole
 * body in memory the tab/device dies somewhere past a couple GB.
 */

export interface StreamDownloadOptions {
  sizeBytes: number
  chunkSize: number
  onProgress: (bytes: number) => void
}

export interface StreamDownloadResult {
  ok: boolean
  error: string | null
  pumpDurationMs: number
  bytesFed: number
}

const READY_TIMEOUT_MS = 8000

export async function runStreamDownloadTest(opts: StreamDownloadOptions): Promise<StreamDownloadResult> {
  const { sizeBytes, chunkSize, onProgress } = opts
  const controller = navigator.serviceWorker?.controller
  if (!controller) {
    return { ok: false, error: 'Service Worker 未控制本页（请先点「重载页面」）', pumpDurationMs: 0, bytesFed: 0 }
  }

  const url = `spike-${crypto.randomUUID()}.bin`
  const channel = new MessageChannel()
  const port = channel.port1
  const swPort = channel.port2

  controller.postMessage({ type: 'stream', url, size: sizeBytes, port: swPort }, [swPort])

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 SW ready 超时')), READY_TIMEOUT_MS)
    port.onmessage = (e) => {
      if (e.data?.ready) { clearTimeout(timer); resolve() }
    }
  })

  // Trigger the download. The fetch goes through the SW which serves the stream.
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'spike-stream.bin'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  const start = Date.now()
  const nChunks = Math.ceil(sizeBytes / chunkSize)
  let fed = 0
  try {
    for (let i = 0; i < nChunks; i++) {
      port.postMessage({ chunk: new ArrayBuffer(chunkSize) })
      fed += chunkSize
      onProgress(fed)
    }
    port.postMessage({ done: true })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), pumpDurationMs: Date.now() - start, bytesFed: fed }
  }

  return { ok: true, error: null, pumpDurationMs: Date.now() - start, bytesFed: fed }
}
