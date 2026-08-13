/**
 * 主线程 ↔ 存储 Worker 的 RPC 消息类型。
 * StorageRequest 携带 reqId（Worker 侧）；StorageRequestInit 是
 * 主线程调用侧省略 reqId 的变体（adapter 统一补上）。
 */

import type { SessionDirInfo } from './types'

export type StorageRequest =
  | { type: 'open-part'; reqId: number; sessionId: string; fileId: number; partIndex: number }
  | { type: 'write'; reqId: number; writerId: number; offset: number; bytes: ArrayBuffer; byteOffset: number; byteLength: number }
  | { type: 'close-writer'; reqId: number; writerId: number }
  | { type: 'read-part'; reqId: number; sessionId: string; fileId: number; partIndex: number }
  | {
      type: 'finalize-part'
      reqId: number
      sessionId: string
      fileId: number
      partIndex: number
      expectedSha256: string
    }
  | { type: 'merge'; reqId: number; sessionId: string; fileId: number; name: string; partCount: number }
  | { type: 'read-merged'; reqId: number; sessionId: string; fileId: number; name: string }
  | { type: 'list-sessions'; reqId: number }
  | { type: 'delete-session'; reqId: number; sessionId: string }
  | { type: 'delete-all'; reqId: number }

/** 调用侧变体：不含 reqId（对联合逐成员 Omit，保留判别） */
type Distribute<U> = U extends unknown ? Omit<U, 'reqId'> : never
export type StorageRequestInit = Distribute<StorageRequest>

export type StorageOkValue =
  | number
  | Uint8Array
  | { ok: boolean; actual: string }
  | SessionDirInfo[]
  | null

export type StorageResponse =
  | { type: 'ok'; reqId: number; value: StorageOkValue }
  | { type: 'err'; reqId: number; message: string }
