/**
 * TransferController —— 传输协调（T05）。
 *
 * 装配接收端（Receiver）与发送端（Sender），统一 framing 解析：
 *   binary → parseChunk（chunk 数据）| parseControl（JSON 控制帧）
 *   string → 裸 JSON 控制消息（T04 兼容）
 * 控制消息路由：meta → Receiver 初始化 + UI；part_reset → Sender 整
 * part 重传；file_done → UI 导出流程。
 */

import { parseChunk, parseControl, encodeControl } from './framing'
import { Receiver } from './receiver'
import { Sender } from './sender'
import { planParts } from '../webrtc/transferMeta'
import { sha256Hex } from '../storage/engine'
import { PART_SIZE } from '../webrtc/transferMeta'
import type { PartSink } from './receiver'
import type { ChunkTransport, FileSource } from './sender'
import type { FileMeta, MetaMessage, TransferControlMessage } from '../protocol/transfer'

export interface ControllerEvents {
  onMeta(files: FileMeta[], sessionId: string): void
  onProgress(fileId: number, sentChunks: number, totalChunks: number): void
  onRecvProgress(fileId: number, partIndex: number, received: number, total: number): void
  onFileDone(fileId: number): void
  onError(reason: string): void
}

export class TransferController {
  private readonly receiver: Receiver
  private readonly transport: ChunkTransport
  private readonly events: ControllerEvents
  private sender: Sender | null = null
  private lastSend: { files: { id: number; name: string; size: number; source: FileSource }[]; signal?: AbortSignal } | null = null

  constructor(sink: PartSink, transport: ChunkTransport, events: ControllerEvents) {
    this.transport = transport
    this.events = events
    this.receiver = new Receiver(
      sink,
      (msg) => this.sendControl(msg),
      {
        onProgress: (f, p, r, t) => this.events.onRecvProgress(f, p, r, t),
        onFileDone: (f) => this.events.onFileDone(f),
      },
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

  /** 发送端：选文件后启动传输（先计算 part SHA-256，meta 先行，再顺序发 chunk） */
  async startSend(
    files: { id: number; name: string; size: number; source: FileSource }[],
    signal?: AbortSignal,
  ): Promise<void> {
    const meta = await this.buildMeta(files, signal)
    this.sendControl(meta)
    const sender = new Sender(
      this.transport,
      {
        onPartDone: () => {
          /* 发送进度由 onProgress 体现；接收端确认走控制消息 */
        },
        onFileDone: (fileId) => this.events.onFileDone(fileId),
        onProgress: (f, c, t) => this.events.onProgress(f, c, t),
      },
    )
    this.sender = sender
    this.lastSend = { files, signal }
    return sender.send(
      files.map((f) => ({ id: f.id, size: f.size, source: f.source })),
      signal,
    )
  }

  /** 组 meta：512MiB 切分 + 每个 part 的整体 SHA-256（SPEC §3.4 元数据先行） */
  private async buildMeta(
    files: { id: number; name: string; size: number; source: FileSource }[],
    signal?: AbortSignal,
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
    return { type: 'meta', sessionId: crypto.randomUUID(), files: fileMetas }
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
        this.receiver.onMeta(msg)
        this.events.onMeta(msg.files, msg.sessionId)
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
          // sender 已结束（发送完成）后才收到重置请求：重启整批（meta 重发，Receiver 幂等）
          void this.startSend(this.lastSend.files, this.lastSend.signal)
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
