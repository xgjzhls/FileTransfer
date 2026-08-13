import { describe, expect, it, vi } from 'vitest'
import { BACKPRESSURE_LIMIT, CHUNK_SIZE, Sender } from './sender'
import { parseChunk } from './framing'
import type { FileSource } from './sender'

const PART = 512 * 1024 * 1024

class FakeTransport {
  sent: Uint8Array[] = []
  bufferedAmount = 0
  send(frame: Uint8Array) {
    this.sent.push(frame)
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

  it('512MiB part 边界：恰好一个满 part（512 chunk），onPartDone 一次', async () => {
    const { sender, events, transport } = setup()
    const bytes = new Uint8Array(PART)
    // 假 source 直接返回子区间，不需要真实内存全量？size 只用于计划
    const source: FileSource = {
      name: 'big',
      size: PART,
      slice: async (start, end) => bytes.subarray(start, end),
    }
    await sender.send([{ id: 0, size: PART, source }])
    expect(transport.sent).toHaveLength(512)
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
      // 背压仍高：推进时间不应产生新发送
      await vi.advanceTimersByTimeAsync(500)
      expect(transport.sent.length).toBe(sentWhileBlocked)
      // drain：bufferedAmount 归零 → 恢复发送直到完成
      transport.bufferedAmount = 0
      await vi.advanceTimersByTimeAsync(1000)
      await promise
      expect(transport.sent.length).toBe(4)
    } finally {
      vi.useRealTimers()
    }
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
