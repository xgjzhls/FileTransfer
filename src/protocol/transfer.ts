/**
 * 传输协议消息类型（SPEC §3.2）—— T04 只互通 meta；
 * part_done/file_done/bye/error/cancel 等随 T05/T06 补充。
 */

export interface PartMeta {
  index: number
  size: number
  /** part 收齐后的整体 SHA-256（发送端在 meta 中携带；T04 为空占位，T05 填真值） */
  sha256: string
}

export interface FileMeta {
  id: number
  name: string
  size: number
  parts: PartMeta[]
}

export interface MetaMessage {
  type: 'meta'
  sessionId: string
  files: FileMeta[]
}

/** part 收齐并通过校验后（SPEC §3.2） */
export interface PartDoneMessage {
  type: 'part_done'
  fileId: number
  partIndex: number
  sha256: string
}

/** 文件全部 part 完成后（SPEC §3.2） */
export interface FileDoneMessage {
  type: 'file_done'
  fileId: number
}

/**
 * part 校验失败 → 整个 part 重传（T05 临时机制；T06 以 bitfield 替换）。
 * 接收端重置该 part 状态，发送端重发全部 chunk。
 */
export interface PartResetMessage {
  type: 'part_reset'
  fileId: number
  partIndex: number
}

/** 单个 part 的续传状态（SPEC §3.2 resume_manifest） */
export interface ResumePartState {
  index: number
  state: 'done' | 'partial'
  /** base64 位图：bit b = 续传块 b 完整（64MiB 粒度）；done 的 part 可留空 */
  bitfield: string
}

export interface ResumeFileState {
  id: number
  parts: ResumePartState[]
}

/** 续传握手：接收端回应 meta（SPEC §3.4 步骤 2） */
export interface ResumeManifestMessage {
  type: 'resume_manifest'
  files: ResumeFileState[]
}

export type TransferControlMessage =
  | MetaMessage
  | PartDoneMessage
  | FileDoneMessage
  | PartResetMessage
  | ResumeManifestMessage
