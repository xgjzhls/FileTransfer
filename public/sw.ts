/// <reference lib="webworker" />
/**
 * LocalTransfer service worker (injectManifest strategy).
 *
 * Combines two jobs:
 *  1. Precache every build asset (Workbox fills __WB_MANIFEST at build time)
 *     — this is what makes the PWA work offline after first visit.
 *  2. Serve the storage-spike stream test: a ReadableStream fed by the page
 *     through a MessagePort, exposed as a download (kept from the spike).
 *
 * Protocol (spike test 2):
 *   page  -> SW : postMessage({ type:'stream', url, size, port })
 *   SW    -> page: port.postMessage({ ready: true })
 *   page  -> SW : port.postMessage({ chunk: ArrayBuffer }) ... { done: true }
 */

import { precacheAndRoute } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope

// Precache all built assets so the app opens offline.
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// --- spike stream serving ---
const streams = new Map<string, { stream: ReadableStream; size: number }>()

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'stream') return
  const { url, size, port } = data

  const stream = new ReadableStream({
    start(controller) {
      port.onmessage = (e: MessageEvent) => {
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
