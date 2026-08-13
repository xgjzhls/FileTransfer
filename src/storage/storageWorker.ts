/**
 * 存储 Worker：接收主线程 RPC 消息，用 OPFS sync access handle 执行读写。
 *
 * sync access handle 只能在 worker 内使用（iOS/WebKit 限制），
 * 且把多 GB 写入循环移出主线程保持 UI 流畅（spike 结论）。
 */

import { StorageEngine } from './engine'
import { OpfsSyncFs } from './opfsSyncFs'
import type { StorageOkValue, StorageRequest, StorageResponse } from './rpc'

interface WorkerScope {
  onmessage: ((e: MessageEvent<StorageRequest>) => void) | null
  postMessage(message: StorageResponse, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

const engine = new StorageEngine(new OpfsSyncFs())

scope.onmessage = (e) => {
  const msg = e.data
  if (!msg || typeof msg.reqId !== 'number') return
  void handle(msg)
}

async function handle(msg: StorageRequest): Promise<void> {
  try {
    switch (msg.type) {
      case 'open-part': {
        const writerId = await engine.openPart(msg.sessionId, msg.fileId, msg.partIndex)
        ok(msg.reqId, writerId)
        break
      }
      case 'write': {
        engine.writeChunk(msg.writerId, msg.offset, new Uint8Array(msg.bytes))
        ok(msg.reqId, null)
        break
      }
      case 'close-writer': {
        engine.closeWriter(msg.writerId)
        ok(msg.reqId, null)
        break
      }
      case 'read-part': {
        const bytes = await engine.readPart(msg.sessionId, msg.fileId, msg.partIndex)
        ok(msg.reqId, bytes, [bytes.buffer])
        break
      }
      case 'finalize-part': {
        const result = await engine.finalizePart(
          msg.sessionId,
          msg.fileId,
          msg.partIndex,
          msg.expectedSha256,
        )
        ok(msg.reqId, result)
        break
      }
      case 'merge': {
        await engine.merge(msg.sessionId, msg.fileId, msg.name, msg.partCount)
        ok(msg.reqId, null)
        break
      }
      case 'read-merged': {
        const bytes = await engine.readMerged(msg.sessionId, msg.fileId, msg.name)
        ok(msg.reqId, bytes, [bytes.buffer])
        break
      }
      case 'list-sessions': {
        ok(msg.reqId, await engine.listSessions())
        break
      }
      case 'delete-session': {
        await engine.deleteSession(msg.sessionId)
        ok(msg.reqId, null)
        break
      }
      case 'delete-all': {
        await engine.deleteAll()
        ok(msg.reqId, null)
        break
      }
    }
  } catch (e) {
    fail(msg.reqId, e instanceof Error ? e.message : String(e))
  }
}

function ok(reqId: number, value: StorageOkValue, transfer?: Transferable[]): void {
  scope.postMessage({ type: 'ok', reqId, value }, transfer)
}

function fail(reqId: number, message: string): void {
  scope.postMessage({ type: 'err', reqId, message })
}
