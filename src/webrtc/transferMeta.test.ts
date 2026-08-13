import { describe, expect, it } from 'vitest'
import { buildMeta, planParts } from './transferMeta'

const PART = 512 * 1024 * 1024 // 512 MiB（SPEC §3.1）

describe('planParts — 512MiB part 划分（SPEC §3.1）', () => {
  it('空文件 → 单个 0 字节 part', () => {
    expect(planParts(0)).toEqual([{ index: 0, size: 0 }])
  })

  it('1 字节 → 单个 part', () => {
    expect(planParts(1)).toEqual([{ index: 0, size: 1 }])
  })

  it('恰好 512MiB → 单个满 part', () => {
    expect(planParts(PART)).toEqual([{ index: 0, size: PART }])
  })

  it('512MiB+1 → 两个 part：[512MiB, 1]', () => {
    expect(planParts(PART + 1)).toEqual([
      { index: 0, size: PART },
      { index: 1, size: 1 },
    ])
  })

  it('1.5×512MiB → 两个 part，末 part 半满', () => {
    expect(planParts(PART + PART / 2)).toEqual([
      { index: 0, size: PART },
      { index: 1, size: PART / 2 },
    ])
  })

  it('各 part 偏移连续无重叠（抽查 3×512MiB+7）', () => {
    const parts = planParts(PART * 3 + 7)
    expect(parts).toHaveLength(4)
    const offset = (p: { index: number; size: number }) => p.index * PART
    expect(offset(parts[1])).toBe(PART)
    expect(offset(parts[2])).toBe(PART * 2)
    expect(parts[3].size).toBe(7)
  })
})

describe('buildMeta — 发送端组 meta（SPEC §3.2 schema）', () => {
  it('files 含 id/name/size/parts（sha256 空占位，T05 填）', () => {
    const meta = buildMeta('sess-1', [{ id: 0, name: 'a.mov', size: PART + 1 }])
    expect(meta).toEqual({
      type: 'meta',
      sessionId: 'sess-1',
      files: [
        {
          id: 0,
          name: 'a.mov',
          size: PART + 1,
          parts: [
            { index: 0, size: PART, sha256: '' },
            { index: 1, size: 1, sha256: '' },
          ],
        },
      ],
    })
  })

  it('多文件清单', () => {
    const meta = buildMeta('sess-2', [
      { id: 0, name: 'a.txt', size: 10 },
      { id: 1, name: 'b.jpg', size: 20 },
    ])
    expect(meta.files).toHaveLength(2)
    expect(meta.files[0].parts).toEqual([{ index: 0, size: 10, sha256: '' }])
    expect(meta.files[1].parts).toEqual([{ index: 0, size: 20, sha256: '' }])
  })

  it('空文件列表 → files: []', () => {
    expect(buildMeta('sess-3', []).files).toEqual([])
  })
})
