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
