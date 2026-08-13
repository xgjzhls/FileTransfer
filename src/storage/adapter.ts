/**
 * StorageAdapter —— 主线程侧存储客户端（T02 验收接口）。
 *
 * 所有读写经 postMessage 转发给存储 Worker（sync access handle 只能在
 * worker 内使用）。chunk 数据以 transferable 移交避免拷贝。
 */

import type { SessionDirInfo } from './types'
import type { StorageOkValue, StorageRequest, StorageRequestInit, StorageResponse } from './rpc'

type FinalizeResult = { ok: boolean; actual: string }

export class StorageAdapter {
  private readonly worker: Worker
  private readonly pending = new Map<
    number,
    { resolve: (value: StorageOkValue) => void; reject: (error: Error) => void }
  >()
  private nextReqId = 1
  private disposed = false

  constructor() {
    this.worker = new Worker(new URL('./storageWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<StorageResponse>) => {
      const msg = e.data
      const entry = this.pending.get(msg.reqId)
      if (!entry) return
      this.pending.delete(msg.reqId)
      if (msg.type === 'ok') entry.resolve(msg.value)
      else entry.reject(new Error(msg.message))
    }
    this.worker.onerror = (e) => {
      const error = new Error(e.message || 'storage worker error')
      for (const [, entry] of this.pending) entry.reject(error)
      this.pending.clear()
    }
  }

  /** 打开（不存在则创建）part 写入句柄，返回 writerId */
  openPart(sessionId: string, fileId: number, partIndex: number): Promise<number> {
    return this.rpc<number>({ type: 'open-part', sessionId, fileId, partIndex })
  }

  /** 在 part 偏移处写入 chunk（payload 可能是 subarray 视图——拷贝出独立 buffer 再 transfer） */
  async writeChunk(writerId: number, offset: number, bytes: Uint8Array): Promise<void> {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    await this.rpc<null>({ type: 'write', writerId, offset, bytes: copy.buffer })
  }

  async closeWriter(writerId: number): Promise<void> {
    await this.rpc<null>({ type: 'close-writer', writerId })
  }

  /** 读回整个 part */
  readPart(sessionId: string, fileId: number, partIndex: number): Promise<Uint8Array> {
    return this.rpc<Uint8Array>({ type: 'read-part', sessionId, fileId, partIndex })
  }

  /** part 收齐后整体 SHA-256 校验 */
  finalizePart(
    sessionId: string,
    fileId: number,
    partIndex: number,
    expectedSha256: string,
  ): Promise<FinalizeResult> {
    return this.rpc<FinalizeResult>({
      type: 'finalize-part',
      sessionId,
      fileId,
      partIndex,
      expectedSha256,
    })
  }

  /** 按 part 顺序拼接为单文件 */
  async merge(sessionId: string, fileId: number, name: string, partCount: number): Promise<void> {
    await this.rpc<null>({ type: 'merge', sessionId, fileId, name, partCount })
  }

  /** 读回已拼接的完整文件（T05 导出用） */
  readMerged(sessionId: string, fileId: number, name: string): Promise<Uint8Array> {
    return this.rpc<Uint8Array>({ type: 'read-merged', sessionId, fileId, name })
  }

  listSessions(): Promise<SessionDirInfo[]> {
    return this.rpc<SessionDirInfo[]>({ type: 'list-sessions' })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.rpc<null>({ type: 'delete-session', sessionId })
  }

  async deleteAll(): Promise<void> {
    await this.rpc<null>({ type: 'delete-all' })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker.terminate()
  }

  private rpc<T extends StorageOkValue>(req: StorageRequestInit): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const reqId = this.nextReqId++
      this.pending.set(reqId, {
        resolve: resolve as (value: StorageOkValue) => void,
        reject,
      })
      const message = { ...req, reqId } as StorageRequest
      if (message.type === 'write') {
        this.worker.postMessage(message, [message.bytes])
      } else {
        this.worker.postMessage(message)
      }
    })
  }
}
