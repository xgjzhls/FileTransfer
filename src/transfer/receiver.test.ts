import { describe, expect, it, vi } from 'vitest'
import { Receiver } from './receiver'
import { CHUNK_SIZE } from './sender'
import type { MetaMessage, PartDoneMessage } from '../protocol/transfer'

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
