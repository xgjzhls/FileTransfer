import { describe, expect, it, vi } from 'vitest'
import { Receiver } from './receiver'
import { CHUNK_SIZE } from './sender'
import { CHUNKS_PER_BLOCK, encodeBitfield } from './bitfield'
import type { SessionManifest } from '../storage/sessionStore'
import type { MetaMessage, PartDoneMessage, ResumeManifestMessage } from '../protocol/transfer'

const META: MetaMessage = {
  type: 'meta',
  sessionId: 'sess-1',
  files: [
    {
      id: 0,
      name: 'a.bin',
      size: CHUNK_SIZE * 2 + 1, // 3 chunk
      parts: [
        { index: 0, size: CHUNK_SIZE * 2 + 1, sha256: 'EXPECTED' },
      ],
    },
  ],
}

class FakeSink {
  openPart = vi.fn(async () => 1)
  writeChunk = vi.fn(async (_w: number, _o: number, _p: Uint8Array) => undefined)
  closeWriter = vi.fn(async () => undefined)
  finalizePart = vi.fn(async () => ({ ok: true, actual: 'EXPECTED' }))
  opened: Array<[number, number]> = []
}

function setup(finalize?: typeof FakeSink.prototype.finalizePart) {
  const sink = new FakeSink()
  if (finalize) sink.finalizePart = finalize
  const controls: unknown[] = []
  const receiver = new Receiver(sink, (msg) => controls.push(msg))
  return { sink, receiver, controls }
}

describe('Receiver — chunk 落盘与 part 完成（SPEC §3.4）', () => {
  it('meta 后收齐 part：open 一次、按偏移写、close、finalize 校验、发 part_done + file_done', async () => {
    const { sink, receiver, controls } = setup()
    receiver.onMeta(META)
    for (let i = 0; i < 3; i++) {
      await receiver.onChunk(0, 0, i, new Uint8Array(i === 2 ? 1 : CHUNK_SIZE))
    }
    expect(sink.openPart).toHaveBeenCalledWith('sess-1', 0, 0)
    expect(sink.writeChunk).toHaveBeenCalledTimes(3)
    expect(sink.writeChunk.mock.calls.map((c) => c[1])).toEqual([0, CHUNK_SIZE, CHUNK_SIZE * 2]) // offset
    expect(sink.closeWriter).toHaveBeenCalled()
    expect(sink.finalizePart).toHaveBeenCalledWith('sess-1', 0, 0, 'EXPECTED')
    expect(controls).toContainEqual({ type: 'part_done', fileId: 0, partIndex: 0, sha256: 'EXPECTED' })
    expect(controls).toContainEqual({ type: 'file_done', fileId: 0 })
    const done = controls.find((c) => (c as PartDoneMessage).type === 'part_done') as PartDoneMessage
    expect(done.sha256).toBe('EXPECTED')
  })

  it('校验失败：发 part_reset，重置后重收能再次完成', async () => {
    let fail = true
    const finalize = vi.fn(async () => {
      const ok = !fail
      fail = false
      return { ok, actual: 'WRONG' }
    })
    const { sink, receiver, controls } = setup(finalize)

    receiver.onMeta(META)
    for (let i = 0; i < 3; i++) await receiver.onChunk(0, 0, i, new Uint8Array(1))
    expect(controls).toContainEqual({ type: 'part_reset', fileId: 0, partIndex: 0 })
    // part 状态已重置：重收全部 chunk → 重新 open（第二次）
    for (let i = 0; i < 3; i++) await receiver.onChunk(0, 0, i, new Uint8Array(1))
    expect(sink.openPart.mock.calls).toHaveLength(2)
    expect(sink.writeChunk.mock.calls).toHaveLength(6)
    expect(controls.filter((c) => (c as PartDoneMessage).type === 'part_done')).toHaveLength(1)
    expect(controls).toContainEqual({ type: 'file_done', fileId: 0 })
  })

  it('重复 chunk（重传）幂等：不重复写盘', async () => {
    const { sink, receiver } = setup()
    receiver.onMeta(META)
    await receiver.onChunk(0, 0, 0, new Uint8Array(CHUNK_SIZE))
    await receiver.onChunk(0, 0, 0, new Uint8Array(CHUNK_SIZE)) // 重传
    await receiver.onChunk(0, 0, 1, new Uint8Array(CHUNK_SIZE))
    await receiver.onChunk(0, 0, 2, new Uint8Array(1))
    expect(sink.writeChunk).toHaveBeenCalledTimes(3)
  })

  it('未知 fileId / 越界 partIndex：静默忽略', async () => {
    const { sink, receiver } = setup()
    receiver.onMeta(META)
    await receiver.onChunk(99, 0, 0, new Uint8Array(1))
    await receiver.onChunk(0, 5, 0, new Uint8Array(1))
    expect(sink.writeChunk).not.toHaveBeenCalled()
  })

  it('并发 chunk（不逐个 await）：按到达顺序串行落盘', async () => {
    const { sink, receiver, controls } = setup()
    receiver.onMeta(META)
    // 同时发 3 个 chunk（fire-and-forget，模拟 DataChannel 到达）
    await Promise.all([
      receiver.onChunk(0, 0, 0, new Uint8Array(CHUNK_SIZE)),
      receiver.onChunk(0, 0, 1, new Uint8Array(CHUNK_SIZE)),
      receiver.onChunk(0, 0, 2, new Uint8Array(1)),
    ])
    expect(sink.openPart).toHaveBeenCalledTimes(1) // 只 open 一次（无竞态）
    expect(sink.writeChunk.mock.calls.map((c) => c[1])).toEqual([0, CHUNK_SIZE, CHUNK_SIZE * 2])
    expect(controls).toContainEqual({ type: 'file_done', fileId: 0 })
  })

  it('0 字节 part：1 个空 chunk 即完成，触发本地 onFileDone', async () => {
    const meta: MetaMessage = {
      type: 'meta',
      sessionId: 's',
      files: [
        { id: 0, name: 'empty.txt', size: 0, parts: [{ index: 0, size: 0, sha256: 'EXPECTED' }] },
      ],
    }
    const { sink, controls } = setup()
    const fileDone: number[] = []
    const receiver2 = new Receiver(sink, (m) => controls.push(m), {
      onProgress: () => {},
      onFileDone: (f) => fileDone.push(f),
    })
    receiver2.onMeta(meta)
    await receiver2.onChunk(0, 0, 0, new Uint8Array(0))
    expect(sink.finalizePart).toHaveBeenCalled()
    expect(controls).toContainEqual({ type: 'file_done', fileId: 0 })
    expect(fileDone).toEqual([0]) // 本地 UI 立即知道完成
  })
})

describe('Receiver — 续传位图（T06）', () => {
  /** 300 chunk 的 part（2 块：块0=[0,256) 块1=[256,300)） */
  const RESUME_META: MetaMessage = {
    type: 'meta',
    sessionId: 'sess',
    files: [
      {
        id: 0,
        name: 'big.bin',
        size: CHUNK_SIZE * 300,
        parts: [{ index: 0, size: CHUNK_SIZE * 300, sha256: 'E' }],
      },
    ],
  }

  const RECORD = (files: SessionManifest['files']): SessionManifest => ({ sessionId: 'sess', createdAt: 1, lastActiveAt: 1, files })

  function resumeSetup() {
    const sink = new FakeSink()
    const controls: unknown[] = []
    const resumeChanges: Array<[number, number, boolean, string]> = []
    const receiver = new Receiver(
      sink,
      (m) => controls.push(m),
      { onProgress: () => {}, onFileDone: () => {} },
      (f, p, done, bitfield) => resumeChanges.push([f, p, done, bitfield]),
    )
    return { sink, receiver, controls, resumeChanges }
  }

  it('meta 立即回应 resume_manifest：全部 partial 空位图（新传输）', () => {
    const { receiver, controls } = resumeSetup()
    receiver.onMeta(RESUME_META)
    const manifest = controls.find((c) => (c as ResumeManifestMessage).type === 'resume_manifest') as ResumeManifestMessage
    expect(manifest.files).toEqual([
      { id: 0, parts: [{ index: 0, state: 'partial', bitfield: encodeBitfield([], 2) }] },
    ])
  })

  it('收满一个续传块 → onResumeChange 上报位图（仅该块置位）', async () => {
    const { receiver, resumeChanges } = resumeSetup()
    receiver.onMeta(RESUME_META)
    for (let c = 0; c < CHUNKS_PER_BLOCK; c++) {
      await receiver.onChunk(0, 0, c, new Uint8Array(CHUNK_SIZE))
    }
    const last = resumeChanges.at(-1)!
    expect(last[0]).toBe(0) // fileId
    expect(last[1]).toBe(0) // partIndex
    expect(last[2]).toBe(false) // 未 done
    expect(decodeLocal(last[3], 2)).toEqual([true, false])
  })

  it('续传恢复：stored 记录（partial 位图）→ 初始化完整块并回应对应 resume_manifest', async () => {
    const stored = RECORD([
      {
        fileId: 0,
        name: 'big.bin',
        size: CHUNK_SIZE * 300,
        partCount: 1,
        parts: [{ index: 0, state: 'partial', bitfield: encodeBitfield([0], 2), sha256: 'E' }],
      },
    ])
    const { sink, receiver, controls } = resumeSetup()
    receiver.onMeta(RESUME_META, stored)
    const manifest = controls.find((c) => (c as ResumeManifestMessage).type === 'resume_manifest') as ResumeManifestMessage
    expect(manifest.files[0].parts[0].state).toBe('partial')
    expect(decodeLocal(manifest.files[0].parts[0].bitfield, 2)).toEqual([true, false])

    // 完整块（块 0）的 chunk 重复到达（防御）：幂等不重写；缺的块 1 正常写
    await receiver.onChunk(0, 0, 0, new Uint8Array(1))
    expect(sink.writeChunk).not.toHaveBeenCalled()
    await receiver.onChunk(0, 0, 256, new Uint8Array(CHUNK_SIZE))
    expect(sink.writeChunk).toHaveBeenCalledTimes(1)
    expect(sink.writeChunk.mock.calls[0][1]).toBe(256 * CHUNK_SIZE)
  })

  it('done part 的 stored 记录：resume_manifest 标 done，chunk 到达被忽略', async () => {
    const stored = RECORD([
      {
        fileId: 0,
        name: 'big.bin',
        size: CHUNK_SIZE * 300,
        partCount: 1,
        parts: [{ index: 0, state: 'done', bitfield: '', sha256: 'E' }],
      },
    ])
    const { sink, receiver, controls } = resumeSetup()
    receiver.onMeta(RESUME_META, stored)
    const manifest = controls.find((c) => (c as ResumeManifestMessage).type === 'resume_manifest') as ResumeManifestMessage
    expect(manifest.files[0].parts[0].state).toBe('done')
    await receiver.onChunk(0, 0, 0, new Uint8Array(1))
    expect(sink.writeChunk).not.toHaveBeenCalled()
  })

  it('sha256 不匹配（文件被改）：该文件不续传，触发 onResumeMismatch', () => {
    const stored = RECORD([
      {
        fileId: 0,
        name: 'big.bin',
        size: CHUNK_SIZE * 300,
        partCount: 1,
        parts: [{ index: 0, state: 'partial', bitfield: encodeBitfield([0], 2), sha256: 'OLD-SHA' }],
      },
    ])
    const mismatch: string[] = []
    const sink = new FakeSink()
    const receiver = new Receiver(sink, () => {}, {
      onProgress: () => {},
      onFileDone: () => {},
      onResumeMismatch: (n) => mismatch.push(n),
    })
    receiver.onMeta(RESUME_META, stored)
    expect(mismatch).toEqual(['big.bin'])
  })

  it('同 sessionId 重连：内存态优先（不回退到持久化记录）', async () => {
    const { receiver, resumeChanges, sink } = resumeSetup()
    receiver.onMeta(RESUME_META)
    // 收块 0
    for (let c = 0; c < CHUNKS_PER_BLOCK; c++) await receiver.onChunk(0, 0, c, new Uint8Array(CHUNK_SIZE))
    const writesAfterFirstRun = sink.writeChunk.mock.calls.length
    // 同 sessionId 重连（stored 为空记录——不应回退）
    const stale = RECORD([
      {
        fileId: 0,
        name: 'big.bin',
        size: CHUNK_SIZE * 300,
        partCount: 1,
        parts: [{ index: 0, state: 'partial', bitfield: '', sha256: 'E' }],
      },
    ])
    receiver.onMeta(RESUME_META, stale)
    // 内存态保留：块 0 已完整，再收块 0 的 chunk 不重写
    await receiver.onChunk(0, 0, 0, new Uint8Array(1))
    expect(sink.writeChunk.mock.calls.length).toBe(writesAfterFirstRun)
    void resumeChanges
  })

  it('校验失败：清空位图 + part_reset + onResumeChange(done=false, 空位图)', async () => {
    let fail = true
    const finalize = vi.fn(async () => {
      const ok = !fail
      fail = false
      return { ok, actual: 'WRONG' }
    })
    const sink = new FakeSink()
    sink.finalizePart = finalize
    const controls: unknown[] = []
    const resumeChanges: Array<[number, number, boolean, string]> = []
    const receiver = new Receiver(
      sink,
      (m) => controls.push(m),
      { onProgress: () => {}, onFileDone: () => {} },
      (f, p, done, bitfield) => resumeChanges.push([f, p, done, bitfield]),
    )
    receiver.onMeta(RESUME_META)
    // 收满块 0 → 位图 [1,0]
    for (let c = 0; c < CHUNKS_PER_BLOCK; c++) await receiver.onChunk(0, 0, c, new Uint8Array(CHUNK_SIZE))
    expect(decodeLocal(resumeChanges.at(-1)![3], 2)).toEqual([true, false])
    // 收满全部 → finalize 失败 → 清位图
    for (let c = CHUNKS_PER_BLOCK; c < 300; c++) await receiver.onChunk(0, 0, c, new Uint8Array(CHUNK_SIZE))
    expect(controls).toContainEqual({ type: 'part_reset', fileId: 0, partIndex: 0 })
    expect(resumeChanges.at(-1)![2]).toBe(false)
    expect(decodeLocal(resumeChanges.at(-1)![3], 2)).toEqual([false, false])
    void controls
  })
})

/** 测试辅助：解码 base64 位图 */
function decodeLocal(b64: string, blockCount: number): boolean[] {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return Array.from({ length: blockCount }, (_, b) => (bytes[b >> 3] & (1 << (b & 7))) !== 0)
}
