/**
 * LocalTransfer — storage spike service worker.
 *
 * Serves a page-fed ReadableStream as a download, to test whether iOS Safari
 * streams a SW-served response to disk (Files app) instead of buffering the
 * whole body in memory (which would crash on multi-GB transfers).
 *
 * Protocol:
 *   page  -> SW : postMessage({ type:'stream', url, size, port })  (port transferred)
 *   SW    -> page: port.postMessage({ ready: true })
 *   page  -> SW : port.postMessage({ chunk: ArrayBuffer }) ... { done: true }
 *   SW    -> page: port.postMessage({ error } | { cancelled })
 */
const streams = new Map()

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'stream') return
  const { url, size, port } = data

  const stream = new ReadableStream({
    start(controller) {
      port.onmessage = (e) => {
        const msg = e.data
        if (msg && msg.done) {
          try { controller.close() } catch { /* already closed */ }
          try { port.close() } catch { /* ignore */ }
        } else if (msg && msg.chunk) {
          try {
            controller.enqueue(msg.chunk)
          } catch (err) {
            try { port.postMessage({ error: String(err) }) } catch { /* ignore */ }
          }
        }
      }
      port.postMessage({ ready: true })
    },
    cancel() {
      try { port.postMessage({ cancelled: true }) } catch { /* ignore */ }
      try { port.close() } catch { /* ignore */ }
    },
  })

  streams.set(url, { stream, size })
  // Safety net: drop the stream if nobody fetches it in time.
  setTimeout(() => streams.delete(url), 120000)
})

self.addEventListener('fetch', (event) => {
  const pathname = new URL(event.request.url).pathname
  const entry = streams.get(pathname)
  if (!entry) return
  streams.delete(pathname)
  event.respondWith(
    new Response(entry.stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="spike-stream.bin"',
        'Content-Length': String(entry.size),
      },
    }),
  )
})
