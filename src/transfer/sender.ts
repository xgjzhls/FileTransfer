/**
 * Sender —— 发送端调度器（SPEC §3.5 / §3.1）。
 *
 * 顺序：一次一个文件，文件内 part 顺序，part 内 chunkIndex 顺序；
 * 背压：transport.bufferedAmount > 8MiB 时暂停排程。
 * chunk framing 见 framing.ts；part 计划复用 transferMeta.planParts。
 */

import { encodeChunk } from './framing'
import { PART_SIZE, planParts } from '../webrtc/transferMeta'
import { blocksInPart, blockChunkRange, decodeBitfield } from './bitfield'
import type { ResumeFileState, ResumePartState } from '../protocol/transfer'

export const CHUNK_SIZE = 256 * 1024 - 64 // 256KiB 留帧头余量（13B 头 + payload ≤ maxMessageSize 262144）
export const BACKPRESSURE_LIMIT = 8 * 1024 * 1024 // SPEC §3.1: >8MiB 暂停

/** 文件字节来源（浏览器侧用 File：slice → arrayBuffer） */
export interface FileSource {
  name: string
  size: number
  slice(start: number, end: number): Promise<Uint8Array>
}

export interface ChunkTransport {
  send(frame: Uint8Array): void
  readonly bufferedAmount: number
  /** 背压：bufferedAmount 降到阈值以下时通知（返回取消函数） */
  onBufferedAmountLow(callback: () => void): () => void
}

export interface SenderEvents {
  onPartDone(fileId: number, partIndex: number): void
  onFileDone(fileId: number): void
  onProgress(fileId: number, sentChunks: number, totalChunks: number): void
}

export class Sender {
  private readonly transport: ChunkTransport
  private readonly events: SenderEvents
  private readonly chunkSize: number
  private readonly resets = new Set<string>()

  constructor(transport: ChunkTransport, events: SenderEvents, chunkSize: number = CHUNK_SIZE) {
    this.transport = transport
    this.events = events
    this.chunkSize = chunkSize
  }

  /** 接收端校验失败后要求整 part 重传（T05；T06 以 bitfield 细化） */
  requestReset(fileId: number, partIndex: number): void {
    this.resets.add(`${fileId}:${partIndex}`)
  }

  async send(
    files: { id: number; size: number; source: FileSource }[],
    resume?: ResumeFileState[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const file of files) {
      const resumeFile = resume?.find((r) => r.id === file.id)
      await this.sendFile(file, resumeFile, signal)
    }
  }

  private async sendFile(
    file: { id: number; size: number; source: FileSource },
    resumeFile: ResumeFileState | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const parts = planParts(file.size, PART_SIZE)
    for (const part of parts) {
      if (signal?.aborted) throw abortError()
      const resumePart = resumeFile?.parts.find((p) => p.index === part.index)
      const chunks = this.scheduleChunks(part.size, resumePart)
      if (chunks.length > 0) {
        await this.sendPart(file, part.index, part.size, chunks, signal)
      }
      this.events.onPartDone(file.id, part.index)
    }
    this.events.onFileDone(file.id)
  }

  /** 本 run 要发送的 chunk 序列：done 跳过；partial 只取缺失块（块内整发）；无记录全发 */
  private scheduleChunks(partSize: number, resumePart?: ResumePartState): number[] {
    const chunkCount = Math.max(1, Math.ceil(partSize / this.chunkSize))
    if (resumePart?.state === 'done') return []
    if (!resumePart) return range(chunkCount)
    const complete = decodeBitfield(resumePart.bitfield, blocksInPart(partSize, this.chunkSize))
    const chunks: number[] = []
    for (let b = 0; b < complete.length; b++) {
      if (complete[b]) continue
      const { start, end } = blockChunkRange(b, chunkCount)
      for (let c = start; c < end; c++) chunks.push(c)
    }
    return chunks
  }

  private async sendPart(
    file: { id: number; size: number; source: FileSource },
    partIndex: number,
    partSize: number,
    chunks: number[],
    signal?: AbortSignal,
  ): Promise<void> {
    const chunkCount = Math.max(1, Math.ceil(partSize / this.chunkSize))
    const partStart = partIndex * PART_SIZE
    const resetKey = `${file.id}:${partIndex}`
    let i = 0
    while (i < chunks.length) {
      if (signal?.aborted) throw abortError()
      if (this.resets.has(resetKey)) {
        // part_reset（接收端清位图）→ 整 part 从头重发
        this.resets.delete(resetKey)
        chunks = range(chunkCount)
        i = 0
        continue
      }
      const chunkIndex = chunks[i]
      const start = partStart + chunkIndex * this.chunkSize
      const end = Math.min(start + this.chunkSize, partStart + partSize)
      const payload = await file.source.slice(start, end)
      const frame = encodeChunk(file.id, partIndex, chunkIndex, payload)
      await this.pump(frame)
      this.events.onProgress(file.id, i + 1, chunks.length)
      i++
    }
  }

  private async pump(frame: Uint8Array): Promise<void> {
    this.transport.send(frame)
    while (this.transport.bufferedAmount > BACKPRESSURE_LIMIT) {
      // bufferedamountlow 事件唤醒（无实现时回退轮询）
      await waitForLow(this.transport)
    }
  }
}

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

function waitForLow(transport: ChunkTransport): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      cancel()
      resolve()
    }
    const cancel = transport.onBufferedAmountLow(finish)
  })
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}
