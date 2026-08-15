/**
 * Receiver —— 接收端（SPEC §3.4）。
 *
 * meta 建立文件/part 状态；chunk 按 chunkIndex×CHUNK_SIZE 偏移写入
 * （经 PartSink → T02 存储 Worker）；part 收齐后整体 SHA-256 校验：
 * 通过 → part_done（全 part 完成 → file_done）；失败 → 清空该 part
 * 的 bitfield 并 part_reset（T06 块级重传语义）。
 *
 * T06 续传：按 64MiB 续传块（256 帧）追踪完整块 → bitfield；
 * meta 时回应 resume_manifest（done 跳过 / partial 附位图）；
 * 支持从持久化 manifest 恢复（onMeta 的 stored 参数）。
 */

import { CHUNK_SIZE } from './sender'
import { CHUNKS_PER_BLOCK, blocksInPart, blockChunkRange, decodeBitfield, encodeBitfield } from './bitfield'
import { isSafeRelPath } from '../storage/path'
import type {
  FileMeta,
  MetaMessage,
  ResumeFileState,
  ResumeManifestMessage,
  ResumePartState,
  TransferControlMessage,
} from '../protocol/transfer'
import type { FileManifest, SessionManifest } from '../storage/sessionStore'

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
  /** 本端作为接收方完成整个文件（本地 UI 更新，不等对方确认） */
  onFileDone(fileId: number): void
  /** 同名同大小文件与已收清单不一致（被改过）→ 该文件重新开始接收 */
  onResumeMismatch?(fileName: string): void
  /** meta 中相对路径非法的文件（../ 穿越等）被跳过 → 提示（防御恶意对端） */
  onInvalidFiles?(names: string[]): void
}

interface PartState {
  partSize: number
  expectedSha256: string
  totalChunks: number
  received: Set<number>
  /** 已完整收到的续传块（bitfield 来源；SPEC §3.1 64MiB = 256 帧/块） */
  completeBlocks: Set<number>
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
  private readonly onResumeChange?: (fileId: number, partIndex: number, done: boolean, bitfield: string) => void
  private files: Map<number, FileState> = new Map()
  private _sessionId = ''
  /** 每 part 一个串行写队列：DataChannel ordered:true 保证到达顺序，串行落盘避免并发 writer 交错 */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    sink: PartSink,
    sendControl: (msg: TransferControlMessage) => void,
    events?: ReceiverEvents,
    onResumeChange?: (fileId: number, partIndex: number, done: boolean, bitfield: string) => void,
  ) {
    this.sink = sink
    this.sendControl = sendControl
    this.events = events ?? { onProgress: () => {}, onFileDone: () => {} }
    this.onResumeChange = onResumeChange
  }

  /**
   * meta：初始化文件/part 状态，并立即回应 resume_manifest（SPEC §3.4 步骤 2）。
   * record：持久化会话记录（按 sessionId 或 name+size 匹配；sha256 校验）。
   * 同 sessionId 重连时内存态优先；发送端重载（新 sessionId 但匹配到旧记录）时
   * **采用旧记录的 sessionId 作为存储目标**——已收数据在旧会话目录里，真块级续传。
   */
  onMeta(meta: MetaMessage, record?: SessionManifest): void {
    const sameSession = meta.sessionId === this._sessionId && this.files.size > 0
    if (!sameSession) {
      // 存储/导出目录沿用已有记录的 sessionId（发送端重载场景），否则用 meta 的
      this._sessionId = record?.sessionId ?? meta.sessionId
      this.files = this.initFiles(meta, record?.files)
    }
    this.sendControl(this.buildResumeManifest())
  }

  /** 当前存储/导出目录对应的 sessionId（发送端重载续传时可能 ≠ meta.sessionId） */
  get sessionId(): string {
    return this._sessionId
  }

  /**
   * 已完整（含从持久化记录恢复）的文件 id 列表。
   * 重启续传时，记录中全部 part 已 done 的文件无需再收块——
   * Controller 据此补发 file_done（UI 导出入口 + 通知发送端）。
   */
  doneFileIds(): number[] {
    const ids: number[] = []
    for (const [fileId, file] of this.files) {
      if (file.parts.size > 0 && file.doneCount === file.parts.size) ids.push(fileId)
    }
    return ids
  }

  onChunk(fileId: number, partIndex: number, chunkIndex: number, payload: Uint8Array): Promise<void> {
    const key = `${fileId}:${partIndex}`
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.processChunk(fileId, partIndex, chunkIndex, payload))
    // 队列吞错但保留给调用方：一个 chunk 失败不阻断后续（如 part_reset 重传）
    this.queues.set(key, next.catch(() => {}))
    return next
  }

  private async processChunk(fileId: number, partIndex: number, chunkIndex: number, payload: Uint8Array): Promise<void> {
    const file = this.files.get(fileId)
    const part = file?.parts.get(partIndex)
    if (!file || !part || part.done) return
    if (part.received.has(chunkIndex)) return // 重传幂等

    part.writerId ??= await this.sink.openPart(this.sessionId, fileId, partIndex)
    await this.sink.writeChunk(part.writerId, chunkIndex * CHUNK_SIZE, payload)
    part.received.add(chunkIndex)
    this.events.onProgress(fileId, partIndex, part.received.size, part.totalChunks)

    // 该 chunk 所属续传块收满 → 位图置位（持久化交给调用方，节流 ≤2s）
    const block = Math.floor(chunkIndex / CHUNKS_PER_BLOCK)
    if (this.blockComplete(part, block)) {
      part.completeBlocks.add(block)
      this.emitResume(fileId, partIndex, part)
    }

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
      this.emitResume(fileId, partIndex, part)
      this.sendControl({ type: 'part_done', fileId, partIndex, sha256: actual })
      file.doneCount += 1
      if (file.doneCount === file.parts.size) {
        this.sendControl({ type: 'file_done', fileId })
        this.events.onFileDone(fileId)
      }
    } else {
      // T06：校验失败 → 清空该 part 的 bitfield，发送端块级重传（等价整 part 重发）
      part.received.clear()
      part.completeBlocks.clear()
      this.emitResume(fileId, partIndex, part)
      this.sendControl({ type: 'part_reset', fileId, partIndex })
    }
  }

  /** 从 meta + 持久化记录初始化（T06：done 跳过 / partial 还原位图；非法路径名跳过） */
  private initFiles(meta: MetaMessage, stored?: FileManifest[]): Map<number, FileState> {
    const files = new Map<number, FileState>()
    const invalid: string[] = []
    for (const file of meta.files) {
      if (!isSafeRelPath(file.name)) {
        invalid.push(file.name)
        continue // 防御：路径穿越名不建状态、不写盘；对应 chunk 到达时被 processChunk 丢弃
      }
      const storedFile = stored?.find((s) => s.name === file.name && s.size === file.size)
      const usable = storedFile !== undefined && partsMatch(storedFile, file)
      if (storedFile && !usable) {
        this.events.onResumeMismatch?.(file.name)
      }
      const parts = new Map<number, PartState>()
      for (const part of file.parts) {
        const sp = usable ? storedFile.parts?.find((p) => p.index === part.index) : undefined
        const done = sp?.state === 'done'
        const received = new Set<number>()
        const completeBlocks = new Set<number>()
        if (!done && sp && sp.bitfield) {
          const blockCount = blocksInPart(part.size, CHUNK_SIZE)
          decodeBitfield(sp.bitfield, blockCount).forEach((ok, b) => {
            if (ok) completeBlocks.add(b)
          })
          // 完整块内的 chunk 视为已收（幂等，避免重写）
          const chunkCount = Math.max(1, Math.ceil(part.size / CHUNK_SIZE))
          for (const b of completeBlocks) {
            const { start, end } = blockChunkRange(b, chunkCount)
            for (let c = start; c < end; c++) received.add(c)
          }
        }
        parts.set(part.index, {
          partSize: part.size,
          expectedSha256: part.sha256,
          totalChunks: Math.max(1, Math.ceil(part.size / CHUNK_SIZE)),
          received,
          completeBlocks,
          done,
          writerId: null,
        })
      }
      files.set(file.id, { name: file.name, parts, doneCount: countDone(parts) })
    }
    if (invalid.length > 0) this.events.onInvalidFiles?.(invalid)
    return files
  }

  private buildResumeManifest(): ResumeManifestMessage {
    const files: ResumeFileState[] = []
    for (const [fileId, file] of this.files) {
      const parts: ResumePartState[] = []
      for (const [partIndex, part] of file.parts) {
        parts.push({
          index: partIndex,
          state: part.done ? 'done' : 'partial',
          bitfield: part.done ? '' : this.partBitfield(part),
        })
      }
      files.push({ id: fileId, parts })
    }
    return { type: 'resume_manifest', files }
  }

  private partBitfield(part: PartState): string {
    return encodeBitfield(part.completeBlocks, blocksInPart(part.partSize, CHUNK_SIZE))
  }

  private blockComplete(part: PartState, block: number): boolean {
    const { start, end } = blockChunkRange(block, part.totalChunks)
    if (start >= end) return false // 越界块（防御）：空区间不算完整
    for (let c = start; c < end; c++) {
      if (!part.received.has(c)) return false
    }
    return true
  }

  private emitResume(fileId: number, partIndex: number, part: PartState): void {
    this.onResumeChange?.(fileId, partIndex, part.done, part.done ? '' : this.partBitfield(part))
  }
}

function countDone(parts: Map<number, PartState>): number {
  let n = 0
  for (const p of parts.values()) if (p.done) n++
  return n
}

/** 持久化记录与 meta 一致：同 index 集合 + 每 part 期望 SHA-256 相同（文件未被改） */
function partsMatch(stored: FileManifest, meta: FileMeta): boolean {
  if (!stored.parts || stored.parts.length !== meta.parts.length) return false
  return meta.parts.every((p) => {
    const sp = stored.parts?.find((x) => x.index === p.index)
    return sp !== undefined && sp.sha256 === p.sha256
  })
}
