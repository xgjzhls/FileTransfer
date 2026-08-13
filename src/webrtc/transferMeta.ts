/**
 * 发送端组 meta（SPEC §3.2）：按 512MiB 把文件切成 part 清单。
 * T04 只互通清单；sha256 空占位，T05 读文件计算后填入。
 */

import type { MetaMessage } from '../protocol/transfer'

export const PART_SIZE = 512 * 1024 * 1024 // SPEC §3.1: 512 MiB

export function planParts(size: number, partSize: number = PART_SIZE): { index: number; size: number }[] {
  const count = Math.max(1, Math.ceil(size / partSize))
  const parts: { index: number; size: number }[] = []
  for (let i = 0; i < count; i++) {
    parts.push({ index: i, size: Math.min(partSize, size - i * partSize) })
  }
  return parts
}

export function buildMeta(
  sessionId: string,
  files: { id: number; name: string; size: number }[],
): MetaMessage {
  return {
    type: 'meta',
    sessionId,
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      parts: planParts(f.size).map((p) => ({ index: p.index, size: p.size, sha256: '' })),
    })),
  }
}
