import { describe, expect, it } from 'vitest'
import {
  CHUNKS_PER_BLOCK,
  blocksInPart,
  blockChunkRange,
  encodeBitfield,
  decodeBitfield,
} from './bitfield'
import { CHUNK_SIZE } from './sender'

describe('bitfield — 续传块参数（SPEC §3.1：64MiB = 256 帧）', () => {
  it('CHUNKS_PER_BLOCK = 256（1 bit = 256 帧）', () => {
    expect(CHUNKS_PER_BLOCK).toBe(256)
  })

  it('blocksInPart：512MiB part = 9 块（2049 chunk ÷ 256）；小 part = 1 块；0 字节 part = 1 块', () => {
    // SPEC 的「每 part 8 块」是近似：实际 CHUNK_SIZE = 256KiB-64 → 512MiB = 2049 chunk → 9 块；
    // 发送/接收端都用同一公式推导块数，一致即可（末块只有 1 个 chunk）
    expect(blocksInPart(512 * 1024 * 1024, CHUNK_SIZE)).toBe(9)
    expect(blocksInPart(CHUNK_SIZE * 10, CHUNK_SIZE)).toBe(1)
    expect(blocksInPart(0, CHUNK_SIZE)).toBe(1) // 0 字节 part 有 1 个空 chunk → 1 块
  })

  it('blocksInPart 与 chunk 数一致：ceil(chunkCount / 256)', () => {
    const chunkCount = CHUNKS_PER_BLOCK * 2 + 1
    expect(blocksInPart(chunkCount * CHUNK_SIZE, CHUNK_SIZE)).toBe(3)
  })

  it('blockChunkRange：块 b 覆盖 [b*256, min((b+1)*256, chunkCount))', () => {
    expect(blockChunkRange(0, 300)).toEqual({ start: 0, end: 256 })
    expect(blockChunkRange(1, 300)).toEqual({ start: 256, end: 300 }) // 末块截断
    expect(blockChunkRange(2, 300)).toEqual({ start: 512, end: 300 }) // 越界块：空区间
  })
})

describe('bitfield — base64 编解码（bit b = 块 b 完整，LSB-first）', () => {
  it('空位图（无块完整）→ 全 0', () => {
    const b64 = encodeBitfield([], 8)
    expect(decodeBitfield(b64, 8)).toEqual([false, false, false, false, false, false, false, false])
  })

  it('置位块往返：{0, 3} → 解码一致', () => {
    const b64 = encodeBitfield([0, 3], 8)
    const decoded = decodeBitfield(b64, 8)
    expect(decoded[0]).toBe(true)
    expect(decoded[3]).toBe(true)
    expect(decoded.filter(Boolean)).toHaveLength(2)
  })

  it('超过 8 块（跨字节）：bit 8 在第 2 字节', () => {
    const b64 = encodeBitfield([8], 16)
    const decoded = decodeBitfield(b64, 16)
    expect(decoded[8]).toBe(true)
    expect(decoded[0]).toBe(false)
  })

  it('空字符串解码 = 全缺（发送端对无记录 part 的兜底）', () => {
    expect(decodeBitfield('', 8)).toEqual([false, false, false, false, false, false, false, false])
  })

  it('越界块索引：encode 忽略', () => {
    const b64 = encodeBitfield([99], 8)
    expect(decodeBitfield(b64, 8)).toEqual([false, false, false, false, false, false, false, false])
  })
})
