/**
 * 续传位图工具（SPEC §3.1：64MiB 续传粒度 = 256 帧/块）。
 *
 * 每 part 的 bitfield 以 base64 编码：bit b = 第 b 个续传块已完整收到。
 * 发送端据此只补发缺失块（块内整发）；接收端为权威（SPEC §3.4）。
 *
 * 不变量（发送端/接收端必须一致）：
 *   blocksInPart(partSize, chunkSize) 决定块数；
 *   块 b 覆盖 chunk [b*256, min((b+1)*256, chunkCount))。
 */

/** 续传块 = 256 帧（SPEC §3.1：1 bit = 256 帧 ≈ 64MiB） */
export const CHUNKS_PER_BLOCK = 256

/** 一个 part 的续传块数（0 大小 part 视为 1 块——含 1 个空 chunk） */
export function blocksInPart(partSize: number, chunkSize: number): number {
  const chunkCount = Math.max(1, Math.ceil(partSize / chunkSize))
  return Math.max(1, Math.ceil(chunkCount / CHUNKS_PER_BLOCK))
}

/** 块 b 覆盖的 chunk 区间 [start, end)（末块/越界按 chunkCount 截断） */
export function blockChunkRange(blockIndex: number, chunkCount: number): { start: number; end: number } {
  const start = blockIndex * CHUNKS_PER_BLOCK
  const end = Math.min(start + CHUNKS_PER_BLOCK, chunkCount)
  return { start, end }
}

/** 完整块集合 → base64（每字节 LSB-first：bit b = 块 b） */
export function encodeBitfield(completeBlocks: Iterable<number>, blockCount: number): string {
  const bytes = new Uint8Array(Math.max(1, Math.ceil(blockCount / 8)))
  for (const b of completeBlocks) {
    if (b >= 0 && b < blockCount) bytes[b >> 3] |= 1 << (b & 7)
  }
  return btoa(String.fromCharCode(...bytes))
}

/** base64 → 每块是否完整（空串 = 全缺，发送端对无记录 part 的兜底） */
export function decodeBitfield(b64: string, blockCount: number): boolean[] {
  const out = new Array<boolean>(blockCount).fill(false)
  if (!b64) return out
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    for (let b = 0; b < blockCount; b++) {
      out[b] = (bytes[b >> 3] & (1 << (b & 7))) !== 0
    }
  } catch {
    /* 非法 base64：按全缺处理 */
  }
  return out
}
