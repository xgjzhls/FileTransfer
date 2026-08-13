import { describe, expect, it, vi } from 'vitest'
import { TransferController } from './controller'
import { encodeChunk, encodeControl, parseChunk, parseControl } from './framing'
import { CHUNK_SIZE } from './sender'
import type { PartSink } from './receiver'
import type { FileSource } from './sender'
import type { MetaMessage } from '../protocol/transfer'

class FakeSink implements PartSink {
  openPart = vi.fn(async () => 1)
  writeChunk = vi.fn(async () => undefined)
  closeWriter = vi.fn(async () => undefined)
  finalizePart = vi.fn(async () => ({ ok: true, actual: 'sha' }))
}

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
  /** 测试辅助：模拟缓冲排空触发事件 */
  drain() {
    this.bufferedAmount = 0
    this.lowCallback?.()
  }
}

function setup() {
  const sink = new FakeSink()
  const transport = new FakeTransport()
  const events = {
    onMeta: [] as unknown[],
    onProgress: [] as unknown[],
    onRecvProgress: [] as unknown[],
    onFileDone: [] as number[],
    onError: [] as string[],
  }
  const controller = new TransferController(sink, transport, {
    onMeta: (files, sessionId) => events.onMeta.push([files, sessionId]),
    onProgress: (f, c, t) => events.onProgress.push([f, c, t]),
    onRecvProgress: (f, p, r, t) => events.onRecvProgress.push([f, p, r, t]),
    onFileDone: (f) => events.onFileDone.push(f),
    onError: (r) => events.onError.push(r),
  })
  return { sink, transport, events, controller }
}

function metaOf(files: { id: number; name: string; size: number }[]): MetaMessage {
  return {
    type: 'meta',
    sessionId: 'sess',
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      parts: [{ index: 0, size: f.size, sha256: 'sha' }],
    })),
  }
}

describe('TransferController — 接收路径', () => {
  it('接收 chunk → onRecvProgress 上报', async () => {
    const { controller, events } = setup()
    controller.handleData(encodeControl(metaOf([{ id: 0, name: 'a.bin', size: CHUNK_SIZE * 2 }])).buffer as ArrayBuffer)
    controller.handleData(encodeChunk(0, 0, 0, new Uint8Array([1])).buffer as ArrayBuffer)
    controller.handleData(encodeChunk(0, 0, 1, new Uint8Array([2])).buffer as ArrayBuffer)
    await new Promise((r) => setTimeout(r, 0))
    expect(events.onRecvProgress).toHaveLength(2)
    expect(events.onRecvProgress[1]).toEqual([0, 0, 2, 2])
  })

  it('binary control（meta 帧）→ onMeta 事件', () => {
    const { controller, events } = setup()
    const meta = metaOf([{ id: 0, name: 'a.txt', size: 10 }])
    controller.handleData(encodeControl(meta).buffer as ArrayBuffer)
    expect(events.onMeta).toHaveLength(1)
    const [files, sessionId] = events.onMeta[0] as [MetaMessage['files'], string]
    expect(files[0].name).toBe('a.txt')
    expect(sessionId).toBe('sess')
  })

  it('裸 JSON 字符串 meta（T04 兼容）同样解析', () => {
    const { controller, events } = setup()
    const meta = metaOf([{ id: 0, name: 'a.txt', size: 10 }])
    controller.handleData(JSON.stringify(meta))
    expect(events.onMeta).toHaveLength(1)
  })

  it('非法数据忽略不抛', () => {
    const { controller, events } = setup()
    controller.handleData('not json')
    controller.handleData(new Uint8Array([9, 9, 9]).buffer as ArrayBuffer)
    expect(events.onError).toEqual([])
  })
})

describe('TransferController — 发送路径', () => {
  it('startSend：先算 part SHA-256，发 meta 控制帧，再按序发 chunk 帧', async () => {
    const { transport, controller } = setup()
    const bytes = new Uint8Array(CHUNK_SIZE * 2 + 1)
    const source: FileSource = {
      name: 'a.bin',
      size: bytes.length,
      slice: async (s, e) => bytes.subarray(s, e),
    }
    await controller.startSend([{ id: 0, name: 'a.bin', size: bytes.length, source }])

    // meta 帧 + 3 chunk 帧
    expect(transport.sent).toHaveLength(4)
    const metaFrame = transport.sent[0]
    expect(parseChunk(metaFrame)).toBeNull() // 控制帧不是 chunk
    const chunks = transport.sent.slice(1).map((f) => parseChunk(f)!)
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2])
    expect(chunks[0].fileId).toBe(0)
  })

  it('meta 携带每个 part 的真实 SHA-256（独立基准）', async () => {
    const { transport, controller } = setup()
    const bytes = new TextEncoder().encode('hello') // sha256 = 2cf24dba...（openssl 生成）
    const source: FileSource = {
      name: 'hello.txt',
      size: bytes.length,
      slice: async (s, e) => bytes.subarray(s, e),
    }
    await controller.startSend([{ id: 0, name: 'hello.txt', size: bytes.length, source }])
    const meta = parseControl(transport.sent[0]) as MetaMessage
    expect(meta.files[0].parts[0].sha256).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('onProgress 回调随 chunk 推进', async () => {
    const { transport, events, controller } = setup()
    const bytes = new Uint8Array(CHUNK_SIZE * 2)
    const source: FileSource = {
      name: 'b',
      size: bytes.length,
      slice: async (s, e) => bytes.subarray(s, e),
    }
    await controller.startSend([{ id: 0, name: 'b', size: bytes.length, source }])
    expect(events.onProgress).toHaveLength(2)
    expect(events.onProgress[1]).toEqual([0, 2, 2])
    void transport
  })

  it('收到 part_reset → 当前 part 重发', async () => {
    const { transport, controller } = setup()
    const bytes = new Uint8Array(CHUNK_SIZE * 3)
    const source: FileSource = {
      name: 'c',
      size: bytes.length,
      slice: async (s, e) => bytes.subarray(s, e),
    }
    let sliceCalls = 0
    const original = source.slice
    source.slice = async (s: number, e: number) => {
      sliceCalls++
      if (sliceCalls === 2) {
        // 第 1 次 slice 是 buildMeta 算哈希；第 2 次是 chunk0 发送时 → sender 已建
        controller.handleData(
          encodeControl({ type: 'part_reset', fileId: 0, partIndex: 0 }).buffer as ArrayBuffer,
        )
      }
      return original(s, e)
    }
    await controller.startSend([{ id: 0, name: 'c', size: bytes.length, source }])
    const chunks = transport.sent.slice(1).map((f) => parseChunk(f)!)
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 0, 1, 2])
  })

  it('收到 file_done → onFileDone 事件', () => {
    const { controller, events } = setup()
    controller.handleData(encodeControl({ type: 'file_done', fileId: 3 }).buffer as ArrayBuffer)
    expect(events.onFileDone).toEqual([3])
  })
})
