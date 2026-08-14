import { describe, expect, it, vi } from 'vitest'
import { BACKPRESSURE_LIMIT, CHUNK_SIZE, Sender } from './sender'
import { parseChunk } from './framing'
import { encodeBitfield } from './bitfield'
import type { FileSource } from './sender'
import type { ResumeFileState } from '../protocol/transfer'

const PART = 512 * 1024 * 1024

class FakeTransport {
  sent: Uint8Array[] = []
  bufferedAmount = 0
  lowCallback: (() => void) | null = null
  send(frame: Uint8Array) {
    this.sent.push(frame)
  }
  onBufferedAmountLow(cb: () => void) {
    this.lowCallback = cb
    return () => {
      this.lowCallback = null
    }
  }
  drain() {
    this.bufferedAmount = 0
    this.lowCallback?.()
  }
}

function sourceOf(bytes: Uint8Array): FileSource {
  return {
    name: 'f',
    size: bytes.length,
    slice: async (start, end) => bytes.subarray(start, end),
  }
}

function setup() {
  const transport = new FakeTransport()
  const events = {
    onPartDone: vi.fn(),
    onFileDone: vi.fn(),
    onProgress: vi.fn(),
  }
  const sender = new Sender(transport, events)
  return { transport, events, sender }
}

describe('Sender — 顺序发送（SPEC §3.5）', () => {
  it('小文件（跨 2 part 边界 + 大 payload）按 chunk 顺序发出，帧解码正确', async () => {
    const { transport, sender } = setup()
    // 2 MiB + 1 字节 → 3 chunk（每 chunk 1MiB）
    const bytes = new Uint8Array(CHUNK_SIZE * 2 + 1).map((_, i) => i % 251)
    await sender.send([{ id: 0, size: bytes.length, source: sourceOf(bytes) }])

    expect(transport.sent).toHaveLength(3)
    const decoded = transport.sent.map((f) => parseChunk(f)!)
    expect(decoded.map((d) => d.fileId)).toEqual([0, 0, 0])
    expect(decoded.map((d) => d.partIndex)).toEqual([0, 0, 0])
    expect(decoded.map((d) => d.chunkIndex)).toEqual([0, 1, 2])
    // payload 拼接 = 源
    const merged = new Uint8Array(bytes.length)
    let at = 0
    for (const d of decoded) {
      merged.set(d.payload, at)
      at += d.payload.length
    }
    expect(merged).toEqual(bytes)
  })

  it('事件顺序：onPartDone 后 onFileDone，progress 每 chunk 一次', async () => {
    const { sender, events } = setup()
    await sender.send([{ id: 0, size: 3, source: sourceOf(new Uint8Array(3)) }])
    expect(events.onProgress).toHaveBeenCalledTimes(1)
    expect(events.onPartDone).toHaveBeenCalledWith(0, 0)
    expect(events.onFileDone).toHaveBeenCalledWith(0)
    const order = [
      ...events.onProgress.mock.invocationCallOrder,
      ...events.onPartDone.mock.invocationCallOrder,
      ...events.onFileDone.mock.invocationCallOrder,
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b)) // 按序：progress → part_done → file_done
  })

  it('一次一个文件：文件 0 全部 chunk 先发完，再发文件 1', async () => {
    const { transport, sender } = setup()
    const a = new Uint8Array(CHUNK_SIZE * 2) // 2 chunk
    const b = new Uint8Array(5) // 1 chunk
    await sender.send([
      { id: 0, size: a.length, source: sourceOf(a) },
      { id: 1, size: b.length, source: sourceOf(b) },
    ])
    const decoded = transport.sent.map((f) => parseChunk(f)!)
    expect(decoded[0].fileId).toBe(0)
    expect(decoded[1].fileId).toBe(0)
    expect(decoded[2].fileId).toBe(1)
  })

  it('512MiB part 边界：恰好一个满 part（2049 chunk），onPartDone 一次', async () => {
    const { sender, events, transport } = setup()
    const bytes = new Uint8Array(PART)
    // 假 source 直接返回子区间，不需要真实内存全量？size 只用于计划
    const source: FileSource = {
      name: 'big',
      size: PART,
      slice: async (start, end) => bytes.subarray(start, end),
    }
    await sender.send([{ id: 0, size: PART, source }])
    expect(transport.sent).toHaveLength(2049)
    expect(events.onPartDone).toHaveBeenCalledTimes(1)
    expect(events.onFileDone).toHaveBeenCalledTimes(1)
  })
})

describe('Sender — 背压（SPEC §3.1: bufferedAmount > 8MiB 暂停）', () => {
  it('bufferedAmount 超限时暂停发送，恢复后继续', async () => {
    vi.useFakeTimers()
    try {
      const { transport, sender } = setup()
      const bytes = new Uint8Array(CHUNK_SIZE * 4)
      const source: FileSource = {
        name: 'f',
        size: bytes.length,
        slice: async (start, end) => bytes.subarray(start, end),
      }
      // 每次 send 后 bufferedAmount 保持超限，直到显式 drain
      transport.bufferedAmount = BACKPRESSURE_LIMIT
      const promise = sender.send([{ id: 0, size: bytes.length, source }])
      // 让第一个 chunk 发出
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent.length).toBeGreaterThanOrEqual(1)
      const sentWhileBlocked = transport.sent.length
      // 背压仍高：推进时间不应产生新发送（等待 bufferedamountlow 事件）
      await vi.advanceTimersByTimeAsync(500)
      expect(transport.sent.length).toBe(sentWhileBlocked)
      // drain：bufferedAmount 归零 + 触发 low 事件 → 恢复发送直到完成
      transport.bufferedAmount = 0
      transport.drain()
      await vi.advanceTimersByTimeAsync(1000)
      await promise
      expect(transport.sent.length).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Sender — 续传调度（T06：done 跳过 / partial 只补缺失块）', () => {
  const C = 64 // 自定义小 chunk：块数公式与默认一致（256 帧/块）

  function setupChunked() {
    const transport = new FakeTransport()
    const events = {
      onPartDone: vi.fn(),
      onFileDone: vi.fn(),
      onProgress: vi.fn(),
    }
    const sender = new Sender(transport, events, C)
    return { transport, events, sender }
  }

  const sourceOf = (bytes: Uint8Array): FileSource => ({
    name: 'f',
    size: bytes.length,
    slice: async (s, e) => bytes.subarray(s, e),
  })

  it('done part 完全跳过：不发任何 chunk，仍触发 onPartDone', async () => {
    const { transport, events, sender } = setupChunked()
    const bytes = new Uint8Array(C * 300)
    await sender.send([{ id: 0, size: bytes.length, source: sourceOf(bytes) }], [
      { id: 0, parts: [{ index: 0, state: 'done', bitfield: '' }] },
    ])
    expect(transport.sent).toHaveLength(0)
    expect(events.onPartDone).toHaveBeenCalledWith(0, 0)
    expect(events.onFileDone).toHaveBeenCalledWith(0)
  })

  it('partial：只发缺失块的 chunk（块内整发，按 chunk 顺序）', async () => {
    const { transport, events, sender } = setupChunked()
    const bytes = new Uint8Array(C * 300) // 300 chunk = 2 块（块0=[0,256) 块1=[256,300)）
    // 块 0 完整 → 只发块 1 的 44 个 chunk（256..299）
    const resume: ResumeFileState[] = [
      { id: 0, parts: [{ index: 0, state: 'partial', bitfield: encodeBitfield([0], 2) }] },
    ]
    await sender.send([{ id: 0, size: bytes.length, source: sourceOf(bytes) }], resume)
    const chunks = transport.sent.map((f) => parseChunk(f)!.chunkIndex)
    expect(chunks).toHaveLength(44)
    expect(chunks[0]).toBe(256)
    expect(chunks.at(-1)).toBe(299)
    expect(events.onProgress).toHaveBeenLastCalledWith(0, 44, 44)
  })

  it('混合：part0 done + part1 partial + part2 无记录（全发）', async () => {
    const { transport, sender } = setupChunked()
    const bytes = new Uint8Array(C * 300)
    const file = (id: number): { id: number; size: number; source: FileSource } => ({
      id,
      size: bytes.length,
      source: sourceOf(bytes),
    })
    // 文件 0：part0 done；文件 1：无记录 → 全发
    const resume: ResumeFileState[] = [
      { id: 0, parts: [{ index: 0, state: 'done', bitfield: '' }] },
    ]
    await sender.send([file(0), file(1)], resume)
    const byFile = new Map<number, number[]>()
    for (const f of transport.sent) {
      const c = parseChunk(f)!
      byFile.set(c.fileId, [...(byFile.get(c.fileId) ?? []), c.chunkIndex])
    }
    expect(byFile.get(0)).toBeUndefined() // 文件 0 跳过
    expect(byFile.get(1)!.length).toBe(300) // 文件 1 全发
  })

  it('partial 发送中收到 part_reset → 整 part 重发（清位图等价）', async () => {
    const { transport, sender } = setupChunked()
    const bytes = new Uint8Array(C * 300)
    const source = sourceOf(bytes)
    const orig = source.slice
    let first = true
    source.slice = async (s: number, e: number) => {
      if (first) {
        first = false
        sender.requestReset(0, 0)
      }
      return orig(s, e)
    }
    await sender.send([{ id: 0, size: bytes.length, source }], [
      { id: 0, parts: [{ index: 0, state: 'partial', bitfield: encodeBitfield([0], 2) }] },
    ])
    const chunks = transport.sent.map((f) => parseChunk(f)!.chunkIndex)
    // chunk 256 发出后 reset 到达 → 从头重发全部 300：sent = [256, 0..299]
    expect(chunks).toHaveLength(301)
    expect(chunks[0]).toBe(256)
    expect(chunks[1]).toBe(0)
    expect(chunks.at(-1)).toBe(299)
  })
})

describe('Sender — part_reset 整 part 重传（T05）', () => {
  it('发送中收到 requestReset(0,0)：当前 part 从头重发', async () => {
    const { transport, sender } = setup()
    const bytes = new Uint8Array(CHUNK_SIZE * 3)
    const source: FileSource = {
      name: 'f',
      size: bytes.length,
      slice: async (start, end) => bytes.subarray(start, end),
    }
    // 第一个 chunk 发出后立刻请求重置
    let requested = false
    const originalSlice = source.slice
    source.slice = async (start: number, end: number) => {
      if (!requested) {
        requested = true
        sender.requestReset(0, 0)
      }
      return originalSlice(start, end)
    }
    await sender.send([{ id: 0, size: bytes.length, source }])

    // chunk0 发出后 reset 到达 → 从 chunk0 重发：sent = [c0, c0, c1, c2]
    // （接收端对重复 c0 幂等，补缺的 c1 c2）
    expect(transport.sent).toHaveLength(4)
    const decoded = transport.sent.map((f) => parseChunk(f)!)
    expect(decoded.map((d) => d.chunkIndex)).toEqual([0, 0, 1, 2])
  })

  it('requestReset 不影响已完成 part 或后续 part', async () => {
    const { transport, sender } = setup()
    const bytes = new Uint8Array(CHUNK_SIZE * 2) // 2 chunk
    const source: FileSource = {
      name: 'f',
      size: bytes.length,
      slice: async (start, end) => bytes.subarray(start, end),
    }
    // 先重置一个不存在的 part：不影响发送
    sender.requestReset(0, 99)
    await sender.send([{ id: 0, size: bytes.length, source }])
    expect(transport.sent).toHaveLength(2)
  })
})

describe('Sender — 取消/中断（T08：中止抛 AbortError，不误标完成）', () => {
  it('发送中被 abort → 抛 AbortError，不触发 onFileDone（取消 ≠ 完成）', async () => {
    const { transport, events, sender } = setup()
    const bytes = new Uint8Array(CHUNK_SIZE * 4).map((_, i) => i % 251)
    const ac = new AbortController()
    // 第一个 chunk 发出后卡在背压等待 → 中途取消
    transport.bufferedAmount = BACKPRESSURE_LIMIT + 1
    const p = sender.send([{ id: 0, size: bytes.length, source: sourceOf(bytes) }], undefined, ac.signal)
    await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThan(0))
    ac.abort()
    transport.bufferedAmount = 0
    transport.drain()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.onFileDone).not.toHaveBeenCalled()
    // 已发出的部分不产生 part_done
    expect(events.onPartDone).not.toHaveBeenCalled()
  })

  it('多文件：已完成的文件标记 done，被取消的当前文件不标记', async () => {
    const { transport, events, sender } = setup()
    const bytes = new Uint8Array(CHUNK_SIZE * 2).map((_, i) => i % 251)
    const ac = new AbortController()
    // 文件 0 正常发完；文件 1 首个 chunk 后卡背压 → 取消
    transport.bufferedAmount = 0
    transport.send = (f) => {
      const saved = transport.sent
      saved.push(f)
      // 文件 0 两个 chunk 发完后文件 1 开始 → 抬高背压卡住
      if (saved.length >= 3) transport.bufferedAmount = BACKPRESSURE_LIMIT + 1
    }
    const p = sender.send(
      [
        { id: 0, size: bytes.length, source: sourceOf(bytes) },
        { id: 1, size: bytes.length, source: sourceOf(bytes) },
      ],
      undefined,
      ac.signal,
    )
    await vi.waitFor(() => expect(events.onFileDone).toHaveBeenCalledWith(0))
    ac.abort()
    transport.bufferedAmount = 0
    transport.drain()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.onFileDone).toHaveBeenCalledTimes(1) // 仅文件 0
    expect(events.onFileDone).toHaveBeenCalledWith(0)
  })
})
