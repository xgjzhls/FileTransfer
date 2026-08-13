/**
 * Receiver —— 接收端（SPEC §3.4）。
 *
 * meta 建立文件/part 状态；chunk 按 chunkIndex×CHUNK_SIZE 偏移写入
 * （经 PartSink → T02 存储 Worker）；part 收齐后整体 SHA-256 校验：
 * 通过 → part_done（全 part 完成 → file_done）；失败 → part_reset
 * （T05 整 part 重传；T06 以 bitfield 替换）。
 */

import { CHUNK_SIZE } from './sender'
import type { MetaMessage, TransferControlMessage } from '../protocol/transfer'

/** 存储写入抽象：T02 StorageAdapter 的子集（UI 层适配） */
export interface PartSink {
  openPart(sessionId: string, fileId: number, partIndex: number): Promise<number>
  writeChunk(writerId: number, offset: number, payload: Uint8Array): Promise<void>
  closeWriter(writerId: number): Promise<void>
  finalizePart(
    sessionId: string,
    fileId: number,
    partIndex: number,
    expectedSha256: string,
  ): Promise<{ ok: boolean; actual: string }>
}

export interface ReceiverEvents {
  /** 每收一个 chunk 上报（接收进度 UI） */
  onProgress(fileId: number, partIndex: number, received: number, total: number): void
}

interface PartState {
  expectedSha256: string
  totalChunks: number
  received: Set<number>
  done: boolean
  writerId: number | null
}

interface FileState {
  name: string
  parts: Map<number, PartState>
  doneCount: number
}

export class Receiver {
  private readonly sink: PartSink
  private readonly sendControl: (msg: TransferControlMessage) => void
  private readonly events: ReceiverEvents
  private files: Map<number, FileState> = new Map()
  private sessionId = ''

  constructor(sink: PartSink, sendControl: (msg: TransferControlMessage) => void, events?: ReceiverEvents) {
    this.sink = sink
    this.sendControl = sendControl
    this.events = events ?? { onProgress: () => {} }
  }

  onMeta(meta: MetaMessage): void {
    this.sessionId = meta.sessionId
    const files = new Map<number, FileState>()
    for (const file of meta.files) {
      const parts = new Map<number, PartState>()
      for (const part of file.parts) {
        parts.set(part.index, {
          expectedSha256: part.sha256,
          totalChunks: Math.max(1, Math.ceil(part.size / CHUNK_SIZE)),
          received: new Set(),
          done: false,
          writerId: null,
        })
      }
      files.set(file.id, { name: file.name, parts, doneCount: 0 })
    }
    this.files = files
  }

  async onChunk(fileId: number, partIndex: number, chunkIndex: number, payload: Uint8Array): Promise<void> {
    const file = this.files.get(fileId)
    const part = file?.parts.get(partIndex)
    if (!file || !part || part.done) return
    if (part.received.has(chunkIndex)) return // 重传幂等

    part.writerId ??= await this.sink.openPart(this.sessionId, fileId, partIndex)
    await this.sink.writeChunk(part.writerId, chunkIndex * CHUNK_SIZE, payload)
    part.received.add(chunkIndex)
    this.events.onProgress(fileId, partIndex, part.received.size, part.totalChunks)

    if (part.received.size === part.totalChunks) {
      await this.completePart(file, fileId, part, partIndex)
    }
  }

  private async completePart(file: FileState, fileId: number, part: PartState, partIndex: number): Promise<void> {
    if (part.writerId !== null) {
      await this.sink.closeWriter(part.writerId)
      part.writerId = null
    }
    const { ok, actual } = await this.sink.finalizePart(this.sessionId, fileId, partIndex, part.expectedSha256)
    if (ok) {
      part.done = true
      this.sendControl({ type: 'part_done', fileId, partIndex, sha256: actual })
      file.doneCount += 1
      if (file.doneCount === file.parts.size) {
        this.sendControl({ type: 'file_done', fileId })
      }
    } else {
      // 整个 part 重传（T05）：清空已收 chunk，发送端将重发全部
      part.received.clear()
      this.sendControl({ type: 'part_reset', fileId, partIndex })
    }
  }
}
