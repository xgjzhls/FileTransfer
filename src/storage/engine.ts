/**
 * StorageEngine —— 接收端存储核心（纯逻辑，不接触浏览器 API）。
 *
 * 由注入的 SyncFs 提供文件读写；生产环境经 Web Worker 用 OPFS sync
 * access handle（iOS 唯一写入 API，spike 验证），单测用内存实现。
 * OPFS 布局遵循 SPEC §4：
 *   sessions/<sessionId>/<fileId>/part-<index>.bin   （接收中的 part）
 *   sessions/<sessionId>/<fileId>/<name>             （完成拼接文件）
 */

import type { SessionDirInfo, SyncFs, SyncHandle } from './types'

/** SPEC §4 布局 —— part 文件路径 */
export function partPath(sessionId: string, fileId: number, partIndex: number): string {
  return `sessions/${sessionId}/${fileId}/part-${partIndex}.bin`
}

/** SPEC §4 布局 —— 拼接文件路径 */
export function mergedPath(sessionId: string, fileId: number, name: string): string {
  return `sessions/${sessionId}/${fileId}/${name}`
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS7 的 BufferSource 要求 ArrayBufferView<ArrayBuffer>；生产路径（File.slice/
  // worker 传输）恒为 ArrayBuffer 支撑，SharedArrayBuffer 不会出现，cast 安全零拷贝
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class StorageEngine {
  private readonly fs: SyncFs
  private readonly writers = new Map<number, SyncHandle>()
  private nextWriterId = 1

  constructor(fs: SyncFs) {
    this.fs = fs
  }

  /** 打开（不存在则创建）part 写入句柄，返回 writerId */
  async openPart(sessionId: string, fileId: number, partIndex: number): Promise<number> {
    const handle = await this.fs.openFile(partPath(sessionId, fileId, partIndex))
    const id = this.nextWriterId++
    this.writers.set(id, handle)
    return id
  }

  /** 在 part 内偏移处写入一个 chunk（同步，经 Worker 消息调用） */
  writeChunk(writerId: number, offset: number, bytes: Uint8Array): void {
    const handle = this.writers.get(writerId)
    if (!handle) throw new Error(`unknown part writer: ${writerId}`)
    handle.write(bytes, { at: offset })
  }

  closeWriter(writerId: number): void {
    const handle = this.writers.get(writerId)
    if (!handle) return
    handle.flush()
    handle.close()
    this.writers.delete(writerId)
  }

  /** 读回整个 part */
  async readPart(sessionId: string, fileId: number, partIndex: number): Promise<Uint8Array<ArrayBuffer>> {
    const handle = await this.fs.openFile(partPath(sessionId, fileId, partIndex))
    try {
      return await readAll(handle)
    } finally {
      handle.close()
    }
  }

  /** part 收齐后整体校验：读回 → SHA-256 → 与期望值比较 */
  async finalizePart(
    sessionId: string,
    fileId: number,
    partIndex: number,
    expectedSha256: string,
  ): Promise<{ ok: boolean; actual: string }> {
    const actual = await sha256Hex(await this.readPart(sessionId, fileId, partIndex))
    return { ok: actual === expectedSha256.toLowerCase(), actual }
  }

  /** 按 part 顺序拼接为单文件（流式拷贝，不整载入内存；part 文件保留供续传） */
  async merge(sessionId: string, fileId: number, name: string, partCount: number): Promise<void> {
    const out = await this.fs.openFile(mergedPath(sessionId, fileId, name))
    try {
      out.truncate(0)
      const buf = new Uint8Array(COPY_CHUNK)
      let outOffset = 0
      for (let i = 0; i < partCount; i++) {
        const part = await this.fs.openFile(partPath(sessionId, fileId, i))
        try {
          let partOffset = 0
          for (;;) {
            const n = part.read(buf, { at: partOffset })
            if (n <= 0) break
            out.write(buf.subarray(0, n), { at: outOffset })
            partOffset += n
            outOffset += n
          }
        } finally {
          part.close()
        }
      }
      out.flush()
    } finally {
      out.close()
    }
  }

  /** 读回已拼接的完整文件 */
  async readMerged(sessionId: string, fileId: number, name: string): Promise<Uint8Array<ArrayBuffer>> {
    const handle = await this.fs.openFile(mergedPath(sessionId, fileId, name))
    try {
      return await readAll(handle)
    } finally {
      handle.close()
    }
  }

  async listSessions(): Promise<SessionDirInfo[]> {
    return this.fs.listSessions()
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.fs.removeSession(sessionId)
  }

  async deleteAll(): Promise<void> {
    await this.fs.removeAll()
  }
}

const COPY_CHUNK = 1024 * 1024 // 1 MiB 流式拷贝缓冲

async function readAll(handle: SyncHandle): Promise<Uint8Array<ArrayBuffer>> {
  const size = handle.getSize()
  const out = new Uint8Array(size)
  let at = 0
  while (at < size) {
    at += handle.read(out.subarray(at), { at })
  }
  return out
}
