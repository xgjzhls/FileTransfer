/**
 * TransferController —— 传输协调（T05 + T06 续传）。
 *
 * 装配接收端（Receiver）与发送端（Sender），统一 framing 解析：
 *   binary → parseChunk（chunk 数据）| parseControl（JSON 控制帧）
 *   string → 裸 JSON 控制消息（T04 兼容）
 * 控制消息路由：meta → Receiver 初始化 + UI + resume_manifest 握手；
 * resume_manifest → Sender 只补缺失块；part_reset → 整 part 重传；
 * file_done → UI 导出流程。
 *
 * T06 续传（SPEC §3.4）：
 * - 发送端：startSend 发 meta 后等 resume_manifest（gate）→ 只发缺失 64MiB 块；
 *   同 sessionId 重连（resumeSend）→ 接收端内存态/持久化位图决定补发集合。
 * - 接收端：位图随块完成更新，经 onResumeChange 节流（≤2s）持久化到 ResumeStore
 *   （IndexedDB），接收端为权威。
 */

import { parseChunk, parseControl, encodeControl } from './framing'
import { Receiver } from './receiver'
import { Sender } from './sender'
import { planParts } from '../webrtc/transferMeta'
import { sha256Hex } from '../storage/engine'
import { PART_SIZE } from '../webrtc/transferMeta'
import type { PartSink } from './receiver'
import type { ChunkTransport, FileSource } from './sender'
import type {
  FileMeta,
  MetaMessage,
  ResumeFileState,
  TransferControlMessage,
} from '../protocol/transfer'
import type { FileManifest, SessionManifest } from '../storage/sessionStore'

export interface ControllerEvents {
  onMeta(files: FileMeta[], sessionId: string): void
  onProgress(fileId: number, sentChunks: number, totalChunks: number): void
  onRecvProgress(fileId: number, partIndex: number, received: number, total: number): void
  onFileDone(fileId: number): void
  onError(reason: string): void
  /** 同名同大小文件与已收清单不一致（被改过）→ 该文件重新接收 */
  onResumeMismatch?(fileName: string): void
  /** 发送端某 part 完成（进度缓存用，可选） */
  onPartDone?(fileId: number, partIndex: number): void
}

/** 接收端权威状态的持久化抽象（SessionStore 满足该结构） */
export interface ResumeStore {
  get(sessionId: string): Promise<SessionManifest | undefined>
  list(): Promise<SessionManifest[]>
  upsert(record: SessionManifest): Promise<void>
}

/** 位图节流持久化间隔（SPEC §3.4：崩溃最多重传 64MiB + 在途） */
export const RESUME_SAVE_MS = 2000
/** 等 resume_manifest 的超时（老接收端不响应时兜底全发） */
const RESUME_GATE_TIMEOUT_MS = 10_000

export class TransferController {
  private readonly receiver: Receiver
  private readonly transport: ChunkTransport
  private readonly events: ControllerEvents
  private readonly resumeStore?: ResumeStore
  private sender: Sender | null = null
  private lastSend: {
    files: { id: number; name: string; size: number; source: FileSource }[]
    signal?: AbortSignal
    sessionId: string
  } | null = null
  /** 接收端权威记录（内存影子，节流写 ResumeStore） */
  private record: SessionManifest | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private recordDirty = false
  /** resume_manifest 到达时解除 startSend 的 gate */
  private resumeWait: { resolve: (plan: ResumeFileState[] | null) => void } | null = null
  private pendingResume: ResumeFileState[] | null = null

  constructor(sink: PartSink, transport: ChunkTransport, events: ControllerEvents, resumeStore?: ResumeStore) {
    this.transport = transport
    this.events = events
    this.resumeStore = resumeStore
    this.receiver = new Receiver(
      sink,
      (msg) => this.sendControl(msg),
      {
        onProgress: (f, p, r, t) => this.events.onRecvProgress(f, p, r, t),
        onFileDone: (f) => this.events.onFileDone(f),
        onResumeMismatch: (n) => this.events.onResumeMismatch?.(n),
      },
      (fileId, partIndex, done, bitfield) => this.onResumeChange(fileId, partIndex, done, bitfield),
    )
  }

  /** DataChannel 数据入口（ConnectionManager.onData → 这里） */
  handleData(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      this.handleControlJson(data)
      return
    }
    const bytes = new Uint8Array(data)
    const chunk = parseChunk(bytes)
    if (chunk) {
      void this.receiver.onChunk(chunk.fileId, chunk.partIndex, chunk.chunkIndex, chunk.payload)
      return
    }
    const control = parseControl(bytes)
    if (control) this.handleControl(control as TransferControlMessage)
  }

  /**
   * 发送端：选文件后启动传输（meta 先行 → 等 resume_manifest → 只补缺失块）。
   * sessionId 可复用（重连续传场景：resumeSend 传入原 sessionId，接收端内存态命中）。
   */
  async startSend(
    files: { id: number; name: string; size: number; source: FileSource }[],
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<void> {
    const meta = await this.buildMeta(files, signal, sessionId)
    this.sendControl(meta)
    const sender = new Sender(
      this.transport,
      {
        onPartDone: (fileId, partIndex) => this.events.onPartDone?.(fileId, partIndex),
        onFileDone: (fileId) => this.events.onFileDone(fileId),
        onProgress: (f, c, t) => this.events.onProgress(f, c, t),
      },
    )
    this.sender = sender
    this.lastSend = { files, signal, sessionId: meta.sessionId }
    const resume = this.pendingResume ?? await this.waitForResume()
    this.pendingResume = null
    await sender.send(
      files.map((f) => ({ id: f.id, size: f.size, source: f.source })),
      resume ?? undefined,
      signal,
    )
    this.sender = null // 发送结束：之后到达的 part_reset 走「重启整批」分支
  }

  /** DataChannel 重连成功后自动续传：同 sessionId 重发 meta → resume 握手 → 只补缺失 */
  async resumeSend(signal?: AbortSignal): Promise<void> {
    if (!this.lastSend) return
    // 上次的 signal 若已中止（断连时取消过）不能复用；调用方可传新信号接管取消
    const useSignal =
      signal ?? (this.lastSend.signal && !this.lastSend.signal.aborted ? this.lastSend.signal : undefined)
    await this.startSend(this.lastSend.files, useSignal, this.lastSend.sessionId)
  }

  /** 立即落盘未完成的位图（pagehide 等时机调用） */
  async flushResume(): Promise<void> {
    await this.flushSave()
  }

  private async handleMeta(msg: MetaMessage): Promise<void> {
    const record = this.resumeStore ? await this.loadStored(msg) : undefined
    this.receiver.onMeta(msg, record)
    // 存储/导出目录用接收端的有效 sessionId（发送端重载续传时沿用旧目录）
    const effSession = this.receiver.sessionId
    this.events.onMeta(msg.files, effSession)
    this.initRecord(msg, effSession, record?.files)
  }

  /** 匹配已有会话记录：先按 sessionId，再按「文件 name+size 集合」（发送端重载） */
  private async loadStored(msg: MetaMessage): Promise<SessionManifest | undefined> {
    const bySession = await this.resumeStore!.get(msg.sessionId)
    if (bySession) return bySession
    const wanted = this.fileKey(msg.files)
    for (const record of await this.resumeStore!.list()) {
      if (record.files.length === msg.files.length && this.fileKey(record.files) === wanted) {
        return record
      }
    }
    return undefined
  }

  private fileKey(files: Array<{ name: string; size: number }>): string {
    return files.map((f) => `${f.name}:${f.size}`).sort().join('|')
  }

  /** 接收端：初始化权威记录（沿用匹配记录中 sha256 一致的 part 状态） */
  private initRecord(msg: MetaMessage, effSession: string, storedFiles?: FileManifest[]): void {
    if (!this.resumeStore) return
    // 同会话（同页重连）：内存记录已是最新（节流持久化覆盖），不重建
    if (this.record && this.record.sessionId === effSession) return
    this.record = {
      sessionId: effSession,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      files: msg.files.map((f) => {
        const sf = storedFiles?.find((s) => s.name === f.name && s.size === f.size)
        const parts = f.parts.map((p) => {
          const sp = sf?.parts?.find((x) => x.index === p.index)
          const usable = sp !== undefined && sp.sha256 === p.sha256
          return usable
            ? { index: p.index, state: sp.state, bitfield: sp.bitfield, sha256: sp.sha256 }
            : { index: p.index, state: 'partial' as const, bitfield: '', sha256: p.sha256 }
        })
        return { fileId: f.id, name: f.name, size: f.size, partCount: f.parts.length, parts }
      }),
    }
    this.recordDirty = true
    this.scheduleSave()
  }

  private onResumeChange(fileId: number, partIndex: number, done: boolean, bitfield: string): void {
    if (!this.record) return
    const file = this.record.files.find((f) => f.fileId === fileId)
    const part = file?.parts?.find((p) => p.index === partIndex)
    if (!file || !part) return
    part.state = done ? 'done' : 'partial'
    part.bitfield = done ? '' : bitfield
    this.recordDirty = true
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (!this.resumeStore || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flushSave()
    }, RESUME_SAVE_MS)
  }

  private async flushSave(): Promise<void> {
    if (!this.resumeStore || !this.record || !this.recordDirty) return
    this.recordDirty = false
    this.record.lastActiveAt = Date.now()
    try {
      await this.resumeStore.upsert(this.record)
    } catch {
      /* 尽力而为：持久化失败不阻断传输 */
    }
  }

  private waitForResume(): Promise<ResumeFileState[] | null> {
    return new Promise((resolve) => {
      const waiter = {
        resolve: (plan: ResumeFileState[] | null) => {
          clearTimeout(timer)
          if (this.resumeWait === waiter) this.resumeWait = null
          resolve(plan)
        },
      }
      const timer = setTimeout(() => waiter.resolve(null), RESUME_GATE_TIMEOUT_MS)
      this.resumeWait = waiter
    })
  }

  /** 组 meta：512MiB 切分 + 每个 part 的整体 SHA-256（SPEC §3.4 元数据先行） */
  private async buildMeta(
    files: { id: number; name: string; size: number; source: FileSource }[],
    signal?: AbortSignal,
    sessionId: string = crypto.randomUUID(),
  ): Promise<MetaMessage> {
    const fileMetas: FileMeta[] = []
    for (const f of files) {
      if (signal?.aborted) throw abortError()
      const parts = planParts(f.size)
      const partsWithHash = []
      for (const p of parts) {
        const start = p.index * PART_SIZE
        const end = start + p.size
        const bytes = await f.source.slice(start, end)
        partsWithHash.push({ index: p.index, size: p.size, sha256: await sha256Hex(bytes) })
      }
      fileMetas.push({ id: f.id, name: f.name, size: f.size, parts: partsWithHash })
    }
    return { type: 'meta', sessionId, files: fileMetas }
  }

  private handleControlJson(raw: string): void {
    let msg: TransferControlMessage
    try {
      msg = JSON.parse(raw) as TransferControlMessage
    } catch {
      return
    }
    this.handleControl(msg)
  }

  private handleControl(msg: TransferControlMessage): void {
    switch (msg.type) {
      case 'meta':
        void this.handleMeta(msg).catch((e) =>
          this.events.onError(e instanceof Error ? e.message : String(e)),
        )
        break
      case 'part_done':
        break // 发送端进度确认（v1 仅 UI 可忽略；file_done 为完成信号）
      case 'file_done':
        this.events.onFileDone(msg.fileId)
        break
      case 'part_reset':
        if (this.sender) {
          this.sender.requestReset(msg.fileId, msg.partIndex)
        } else if (this.lastSend) {
          // sender 已结束（发送完成）后才收到重置请求：重启整批（同 sessionId 重握手）
          void this.startSend(this.lastSend.files, this.lastSend.signal, this.lastSend.sessionId)
        }
        break
      case 'resume_manifest':
        // 迟到的 manifest（gate 已超时）落入 pendingResume：被下一次 startSend 消费。
        // 安全前提：旧 plan 只会导致少发（receiver 已收块），最终由 SHA-256 校验/part_reset 自愈
        if (this.resumeWait) {
          this.resumeWait.resolve(msg.files)
          this.resumeWait = null
        } else {
          this.pendingResume = msg.files
        }
        break
    }
  }

  private sendControl(msg: TransferControlMessage): void {
    this.transport.send(encodeControl(msg))
  }
}

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}
