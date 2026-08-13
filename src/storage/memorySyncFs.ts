/**
 * 内存版 SyncFs —— 仅用于单测。
 *
 * 路径即 key（与生产 OPFS 实现共用 SPEC §4 布局），
 * 句柄语义镜像 OPFS sync access handle：{at} 显式定位、
 * 写超 EOF 自动扩展、读超 EOF 返回 0。
 */

import type { SessionDirInfo, SyncFs, SyncHandle } from './types'

const SESSION_PREFIX = 'sessions/'

export class MemorySyncFs implements SyncFs {
  private readonly files = new Map<string, Uint8Array>()

  async openFile(path: string): Promise<SyncHandle> {
    if (!this.files.has(path)) this.files.set(path, new Uint8Array(0))
    return new MemoryHandle(path, this.files)
  }

  async listSessions(): Promise<SessionDirInfo[]> {
    const sizes = new Map<string, number>()
    for (const [path, bytes] of this.files) {
      if (!path.startsWith(SESSION_PREFIX)) continue
      const sessionId = path.slice(SESSION_PREFIX.length).split('/')[0]
      if (!sessionId) continue
      sizes.set(sessionId, (sizes.get(sessionId) ?? 0) + bytes.length)
    }
    return [...sizes.entries()].map(([sessionId, bytes]) => ({ sessionId, bytes }))
  }

  async removeSession(sessionId: string): Promise<void> {
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${SESSION_PREFIX}${sessionId}/`)) this.files.delete(path)
    }
  }

  async removeAll(): Promise<void> {
    this.files.clear()
  }
}

class MemoryHandle implements SyncHandle {
  private readonly path: string
  private readonly store: Map<string, Uint8Array>

  constructor(path: string, store: Map<string, Uint8Array>) {
    this.path = path
    this.store = store
  }

  getSize(): number {
    return this.store.get(this.path)!.length
  }

  read(buffer: ArrayBufferView, options?: { at?: number }): number {
    const buf = this.store.get(this.path)!
    const at = options?.at ?? 0
    if (at >= buf.length) return 0
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const n = Math.min(view.length, buf.length - at)
    view.set(buf.subarray(at, at + n))
    return n
  }

  write(buffer: ArrayBufferView, options?: { at?: number }): number {
    const at = options?.at ?? 0
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    let buf = this.store.get(this.path)!
    if (at + view.length > buf.length) {
      const next = new Uint8Array(at + view.length)
      next.set(buf)
      this.store.set(this.path, next)
      buf = next
    }
    buf.set(view, at)
    return view.length
  }

  truncate(size: number): void {
    const buf = this.store.get(this.path)!
    const next = new Uint8Array(size)
    next.set(buf.subarray(0, Math.min(size, buf.length)))
    this.store.set(this.path, next)
  }

  flush(): void {
    /* 内存实现无需落盘 */
  }

  close(): void {
    /* 无资源释放 */
  }
}
