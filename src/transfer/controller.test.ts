import { describe, expect, it, vi } from 'vitest'
import { TransferController } from './controller'
import type { ResumeStore } from './controller'
import { encodeChunk, encodeControl, parseChunk, parseControl } from './framing'
import { BACKPRESSURE_LIMIT, CHUNK_SIZE } from './sender'
import { CHUNKS_PER_BLOCK } from './bitfield'
import { sha256Hex } from '../storage/engine'
import type { PartSink } from './receiver'
import type { FileSource } from './sender'
import type { MetaMessage, ResumeFileState, ResumeManifestMessage, TransferControlMessage } from '../protocol/transfer'
import type { SessionManifest } from '../storage/sessionStore'

// ── 基础 fake（旧式单端测试用） ──────────────────────────────────────────────

class FakeSink implements PartSink {
  openPart = vi.fn(async () => 1)
  writeChunk = vi.fn(async () => undefined)
  closeWriter = vi.fn(async () => undefined)
  finalizePart = vi.fn(async () => ({ ok: true, actual: 'sha' }))
}

/** 发送端测试用 transport：meta 帧发出后自动回一个「全缺」resume_manifest（T06 握手） */
class AutoResumeTransport {
  sent: Uint8Array[] = []
  bufferedAmount = 0
  lowCallback: (() => void) | null = null
  onResume: ((files: ResumeFileState[]) => void) | null = null

  send(frame: Uint8Array) {
    this.sent.push(frame)
    const control = parseControl(frame) as TransferControlMessage | null
    if (control?.type === 'meta' && this.onResume) {
      this.onResume(
        control.files.map((f) => ({
          id: f.id,
          parts: f.parts.map((p) => ({ index: p.index, state: 'partial', bitfield: '' })),
        })),
      )
    }
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

function setup() {
  const sink = new FakeSink()
  const transport = new AutoResumeTransport()
  const events = {
    onMeta: [] as unknown[],
    onProgress: [] as unknown[],
    onRecvProgress: [] as unknown[],
    onFileDone: [] as number[],
    onError: [] as string[],
    onResumeMismatch: [] as string[],
    onPartDone: [] as [number, number][],
  }
  const controller = new TransferController(sink, transport, {
    onMeta: (files, sessionId) => events.onMeta.push([files, sessionId]),
    onProgress: (f, c, t) => events.onProgress.push([f, c, t]),
    onRecvProgress: (f, p, r, t) => events.onRecvProgress.push([f, p, r, t]),
    onFileDone: (f) => events.onFileDone.push(f),
    onError: (r) => events.onError.push(r),
    onResumeMismatch: (n) => events.onResumeMismatch.push(n),
    onPartDone: (f, p) => events.onPartDone.push([f, p]),
  })
  transport.onResume = (files) => {
    controller.handleData(encodeControl({ type: 'resume_manifest', files } satisfies ResumeManifestMessage).buffer as ArrayBuffer)
  }
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

// ── 端到端（wire pair + 真字节 MemorySink + FakeResumeStore） ────────────────

/**
 * 真字节内存 sink：按 (sessionId, fileId, partIndex) 存 chunk（与真实 OPFS 按会话
 * 分目录一致），finalize 计算真实 SHA-256，可拼接出 part 完整字节。
 */
class MemorySink implements PartSink {
  readonly chunks = new Map<string, Map<number, Uint8Array>>()
  readonly finalized: string[] = []
  private writers = new Map<number, { key: string; fileId: number; partIndex: number }>()
  private nextWriter = 1
  failNextFinalize = false

  async openPart(sessionId: string, fileId: number, partIndex: number): Promise<number> {
    const key = `${sessionId}:${fileId}:${partIndex}`
    // 续传时磁盘上已有该 part 的部分字节：只在不存在时创建（不清空已有数据）
    if (!this.chunks.has(key)) this.chunks.set(key, new Map())
    const id = this.nextWriter++
    this.writers.set(id, { key, fileId, partIndex })
    return id
  }
  async writeChunk(writerId: number, offset: number, payload: Uint8Array): Promise<void> {
    const { key } = this.writers.get(writerId)!
    this.chunks.get(key)!.set(offset, new Uint8Array(payload))
  }
  async closeWriter(writerId: number): Promise<void> {
    this.writers.delete(writerId)
  }
  async finalizePart(sessionId: string, fileId: number, partIndex: number, expectedSha256: string) {
    const bytes = this.mergePart(sessionId, fileId, partIndex)
    const actual = await sha256Hex(bytes)
    this.finalized.push(`${sessionId}:${fileId}:${partIndex}`)
    if (this.failNextFinalize) {
      this.failNextFinalize = false
      return { ok: false, actual }
    }
    return { ok: actual === expectedSha256, actual }
  }
  /** 按 offset 顺序拼接 part 字节 */
  mergePart(sessionId: string, fileId: number, partIndex: number): Uint8Array {
    const map = this.chunks.get(`${sessionId}:${fileId}:${partIndex}`) ?? new Map()
    const offsets = [...map.keys()].sort((a, b) => a - b)
    const total = offsets.reduce((s, o) => s + map.get(o)!.length, 0)
    const buf = new Uint8Array(total)
    let at = 0
    for (const o of offsets) {
      buf.set(map.get(o)!, at)
      at += map.get(o)!.length
    }
    return buf
  }
}

class FakeResumeStore implements ResumeStore {
  readonly records = new Map<string, SessionManifest>()
  async get(sessionId: string) {
    return this.records.get(sessionId)
  }
  async list() {
    return [...this.records.values()]
  }
  async upsert(record: SessionManifest) {
    this.records.set(record.sessionId, structuredClone(record))
  }
}

interface Pair {
  a: TransferController
  b: TransferController
  sinkA: MemorySink
  sinkB: MemorySink
  store: FakeResumeStore
  transportA: WireTransport
  transportB: WireTransport
}

type SentFrame = { kind: 'control' | 'chunk'; chunkIndex?: number }

/** A→B 方向的可控 transport：按帧计数触发背压暂停（确定性的「传到一半断连」） */
class WireTransport {
  readonly sent: SentFrame[] = []
  bufferedAmount = 0
  lowCallback: (() => void) | null = null
  /** 帧数达到该值后置背压（null = 不暂停）；测试可中途改 */
  pauseAfter: number | null = null
  /** 首个 meta 帧（sessionId 提取） */
  meta: MetaMessage | null = null
  private target: (frame: Uint8Array) => void

  constructor(target: (frame: Uint8Array) => void, pauseAfter: number | null = null) {
    this.target = target
    this.pauseAfter = pauseAfter
  }

  /** 重载模拟：把链路指向新实例 */
  setTarget(fn: (frame: Uint8Array) => void): void {
    this.target = fn
  }

  send(frame: Uint8Array) {
    const chunk = parseChunk(frame)
    const control = chunk ? null : (parseControl(frame) as TransferControlMessage | null)
    this.sent.push(chunk ? { kind: 'chunk', chunkIndex: chunk.chunkIndex } : { kind: 'control' })
    if (control?.type === 'meta' && !this.meta) this.meta = control
    this.target(frame)
    // 超过阈值后把缓冲置为超限 → 发送端 pump 停住（模拟连接被掐/背压）
    if (this.pauseAfter !== null && this.sent.length >= this.pauseAfter) {
      this.bufferedAmount = BACKPRESSURE_LIMIT + 1
    }
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

/** 两台 controller 用真字节 sink + 共享 resume store 互联 */
function pair(opts: { failOnce?: boolean } = {}): Pair {
  const store = new FakeResumeStore()
  const sinkA = new MemorySink()
  const sinkB = new MemorySink()
  if (opts.failOnce) sinkB.failNextFinalize = true

  let a!: TransferController
  let b!: TransferController
  const transportA = new WireTransport((f) => b.handleData(f.buffer as ArrayBuffer))
  const transportB = new WireTransport((f) => a.handleData(f.buffer as ArrayBuffer))

  const eventsOf = () => ({
    onMeta: () => {},
    onProgress: () => {},
    onRecvProgress: () => {},
    onFileDone: () => {},
    onError: () => {},
    onResumeMismatch: () => {},
    onPartDone: () => {},
  })
  a = new TransferController(sinkA, transportA, eventsOf(), store)
  b = new TransferController(sinkB, transportB, eventsOf(), store)
  return { a, b, sinkA, sinkB, store, transportA, transportB }
}

function bigSource(sizeBytes = CHUNK_SIZE * 300): { file: { id: number; name: string; size: number; source: FileSource }; bytes: Uint8Array } {
  // 均匀字节即可（sha256 一致性）；避免 .map() 二次分配
  const bytes = new Uint8Array(sizeBytes).fill(0x5a)
  return {
    bytes,
    file: {
      id: 0,
      name: 'big.bin',
      size: bytes.length,
      source: { name: 'big.bin', size: bytes.length, slice: async (s, e) => bytes.subarray(s, e) },
    },
  }
}


/** 跨会话统计某 part 已收 chunk 数（MemorySink 按 sessionId 分 key，与真实 OPFS 一致） */
function partChunkCount(sink: MemorySink, fileId: number, partIndex: number): number {
  for (const [key, map] of sink.chunks) {
    const parts = key.split(':')
    if (parts.length === 3 && Number(parts[1]) === fileId && Number(parts[2]) === partIndex) return map.size
  }
  return 0
}

const waitUntil = async (fn: () => boolean, timeoutMs = 5000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
    await new Promise((r) => setTimeout(r, 0))
  }
}

const noopEvents = () => ({
  onMeta: () => {},
  onProgress: () => {},
  onRecvProgress: () => {},
  onFileDone: () => {},
  onError: () => {},
  onResumeMismatch: () => {},
  onPartDone: () => {},
})

function makeReceiver(sink: PartSink, store: FakeResumeStore, sendTo: (f: Uint8Array) => void): TransferController {
  return new TransferController(
    sink,
    { send: (f) => sendTo(f), bufferedAmount: 0, onBufferedAmountLow: () => () => {} },
    noopEvents(),
    store,
  )
}

function makeSender(
  transport: { send(frame: Uint8Array): void; readonly bufferedAmount: number; onBufferedAmountLow(callback: () => void): () => void },
  events: ReturnType<typeof noopEvents>,
): TransferController {
  return new TransferController(new FakeSink(), transport, events)
}

/** 发送端用的可控 transport：到达 N 帧后置背压暂停 */
function pacedTransport(sent: SentFrame[], target: (f: Uint8Array) => void, pauseAfter: number) {
  const t: {
    sent: SentFrame[]
    bufferedAmount: number
    lowCallback: (() => void) | null
    pauseAfter: number | null
    meta: MetaMessage | null
    send(f: Uint8Array): void
    onBufferedAmountLow(cb: () => void): () => void
    drain(): void
  } = {
    sent,
    bufferedAmount: 0,
    lowCallback: null,
    pauseAfter,
    meta: null,
    send(f: Uint8Array) {
      const chunk = parseChunk(f)
      const control = chunk ? null : (parseControl(f) as TransferControlMessage | null)
      sent.push(chunk ? { kind: 'chunk', chunkIndex: chunk.chunkIndex } : { kind: 'control' })
      if (control?.type === 'meta' && !t.meta) t.meta = control
      target(f)
      if (t.pauseAfter !== null && sent.length >= t.pauseAfter) {
        this.bufferedAmount = BACKPRESSURE_LIMIT + 1
      }
    },
    onBufferedAmountLow(cb: () => void) {
      this.lowCallback = cb
      return () => {
        this.lowCallback = null
      }
    },
    drain() {
      this.bufferedAmount = 0
      this.lowCallback?.()
    },
  }
  return t
}

describe('TransferController — 文件夹发送（SPEC §6.3 相对路径）', () => {
  /** 文件夹场景：多个文件，name 为相对路径（含子目录）；构造真实字节源 */
  function folderFiles(): {
    files: { id: number; name: string; size: number; source: FileSource }[]
    bytesOf: (name: string) => Uint8Array
  } {
    const enc = new TextEncoder()
    const contents: Record<string, string> = {
      'photos/2024/img.jpg': 'JPEGDATA',
      'photos/readme.txt': 'read',
      'top.txt': 'topfile',
    }
    const files = Object.entries(contents).map(([name, text], id) => {
      const bytes = enc.encode(text)
      return {
        id,
        name,
        size: bytes.length,
        source: { name, size: bytes.length, slice: async (s: number, e: number) => bytes.subarray(s, e) },
      }
    })
    return { files, bytesOf: (n: string) => enc.encode(contents[n]) }
  }

  it('相对路径作为 meta name 传输：B 完整接收，字节与源一致', async () => {
    const store = new FakeResumeStore()
    const sinkB = new MemorySink()
    const metaNames: string[] = []
    // B→A 路由（resume_manifest 回程），避免等待 10s gate 超时
    let senderTarget: (f: Uint8Array) => void = () => {}
    const b = new TransferController(
      sinkB,
      { send: (f) => senderTarget(f), bufferedAmount: 0, onBufferedAmountLow: () => () => {} },
      { ...noopEvents(), onMeta: (files) => metaNames.push(...files.map((x) => x.name)) },
      store,
    )

    const sent: SentFrame[] = []
    const a = makeSender(
      {
        send: (f) => {
          const chunk = parseChunk(f)
          sent.push(chunk ? { kind: 'chunk', chunkIndex: chunk.chunkIndex } : { kind: 'control' })
          b.handleData(f.buffer as ArrayBuffer)
        },
        bufferedAmount: 0,
        onBufferedAmountLow: () => () => {},
      },
      noopEvents(),
    )
    senderTarget = (f) => a.handleData(f.buffer as ArrayBuffer)

    const { files, bytesOf } = folderFiles()
    await a.startSend(files)

    // meta 名 = 相对路径（接收端据此建 OPFS 子目录）
    expect(metaNames).toEqual(['photos/2024/img.jpg', 'photos/readme.txt', 'top.txt'])
    // 全部 chunk 发出（8+4+7 字节，各 1 chunk），接收端三个 part 落盘校验完成
    expect(sent.filter((s) => s.kind === 'chunk')).toHaveLength(3)
    await waitUntil(() => sinkB.finalized.length === 3)
    expect(sinkB.finalized).toHaveLength(3)
    // 用实际 sessionId（a 随机生成）读回，字节与源一致
    const sessionId = sinkB.finalized[0].split(':')[0]
    for (let i = 0; i < 3; i++) {
      const bytes = await sinkB.mergePart(sessionId, i, 0)
      expect(new TextDecoder().decode(bytes)).toBe(new TextDecoder().decode(bytesOf(files[i].name)))
    }
  })

  it('文件夹续传：发送端重载后按相对路径 name+size 匹配已收会话，只补缺失', async () => {
    const store = new FakeResumeStore()
    const sinkB = new MemorySink()
    let senderTarget: (f: Uint8Array) => void = () => {}
    const b = makeReceiver(sinkB, store, (f) => senderTarget(f))

    // 文件夹：文件 0 为 300 chunk 大文件（相对路径），文件 1/2 小文件
    const big = bigSource(CHUNK_SIZE * 300)
    const enc = new TextEncoder()
    const small1 = enc.encode('read')
    const small2 = enc.encode('topfile')
    const files = [
      { id: 0, name: 'photos/big.bin', size: big.bytes.length, source: big.file.source },
      {
        id: 1,
        name: 'photos/readme.txt',
        size: small1.length,
        source: {
          name: 'photos/readme.txt',
          size: small1.length,
          slice: async (s: number, e: number) => small1.subarray(s, e),
        },
      },
      {
        id: 2,
        name: 'top.txt',
        size: small2.length,
        source: {
          name: 'top.txt',
          size: small2.length,
          slice: async (s: number, e: number) => small2.subarray(s, e),
        },
      },
    ]

    // 第一轮：meta + 块 0（256 chunk）发出后背压暂停 → 中断
    const sent1: SentFrame[] = []
    const t1 = pacedTransport(sent1, (f) => b.handleData(f.buffer as ArrayBuffer), 1 + CHUNKS_PER_BLOCK)
    const a1 = makeSender(t1, noopEvents())
    senderTarget = (f) => a1.handleData(f.buffer as ArrayBuffer)
    const ac = new AbortController()
    const p1 = a1.startSend(files, ac.signal)
    await waitUntil(() => t1.meta !== null)
    await waitUntil(() => partChunkCount(sinkB, 0, 0) >= CHUNKS_PER_BLOCK)
    ac.abort()
    t1.drain()
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    t1.pauseAfter = null
    await new Promise((r) => setTimeout(r, 2100)) // 位图节流落盘
    expect(store.records.size).toBe(1)
    const sid = t1.meta!.sessionId

    // 发送端重载：新实例新 sessionId，重新选同一文件夹 → 相对路径 name+size 匹配
    const sent2: SentFrame[] = []
    const a2 = makeSender(
      {
        send: (f) => {
          const chunk = parseChunk(f)
          sent2.push(chunk ? { kind: 'chunk', chunkIndex: chunk.chunkIndex } : { kind: 'control' })
          b.handleData(f.buffer as ArrayBuffer)
        },
        bufferedAmount: 0,
        onBufferedAmountLow: () => () => {},
      },
      noopEvents(),
    )
    senderTarget = (f) => a2.handleData(f.buffer as ArrayBuffer)
    await a2.startSend(files)

    // 文件 0 只补块 1（44 chunk）；文件 1/2 全发（各 1 chunk）—— 相对路径匹配命中
    expect(sent2.filter((s) => s.kind === 'chunk')).toHaveLength(300 - CHUNKS_PER_BLOCK + 2)
    await waitUntil(() => sinkB.finalized.length === 3)
    expect(sinkB.finalized).toHaveLength(3)
    // 接收端沿用第一轮会话目录（重载匹配），字节与源一致
    expect(await sha256Hex(sinkB.mergePart(sid, 0, 0))).toBe(await sha256Hex(big.bytes))
    expect(new TextDecoder().decode(await sinkB.mergePart(sid, 1, 0))).toBe('read')
    expect(new TextDecoder().decode(await sinkB.mergePart(sid, 2, 0))).toBe('topfile')
  })
})

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
  it('startSend：先算 part SHA-256，发 meta 控制帧，等 resume_manifest 后按序发 chunk 帧', async () => {
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

  it('hasActiveSend：无发送为 false；发送中为 true；完成后为 false（可 resumeSend 但不算在途）', async () => {
    const { controller } = setup()
    expect(controller.hasActiveSend()).toBe(false)
    const bytes = new Uint8Array(CHUNK_SIZE * 2)
    const source: FileSource = {
      name: 'h',
      size: bytes.length,
      slice: async (s, e) => bytes.subarray(s, e),
    }
    const p = controller.startSend([{ id: 0, name: 'h', size: bytes.length, source }])
    expect(controller.hasActiveSend()).toBe(true) // buildMeta 阶段即在途
    await p
    expect(controller.hasActiveSend()).toBe(false) // 完成：不算在途（避免误触发旧批次续传）
    const r = controller.resumeSend()
    expect(controller.hasActiveSend()).toBe(true) // 续传进行中
    await r
    expect(controller.hasActiveSend()).toBe(false)
  })
})

// ── T06 端到端：断连 → 恢复 → 只补缺失 ───────────────────────────────────────

describe('TransferController — 续传端到端（T06 主 seam）', () => {
  it('断连重建：第二轮只补缺失块，重传量 ≈ 缺失量，最终文件与源一致', async () => {
    const { a, b, sinkB, transportA } = pair()
    const { file, bytes } = bigSource()
    const ac = new AbortController()

    // 第一轮：meta + 块 0（256 chunk）发出后，发送端被背压停住 → 断连
    transportA.pauseAfter = 1 + CHUNKS_PER_BLOCK // meta 帧 + 256 chunk 后暂停
    const run1 = a.startSend([file], ac.signal)
    await waitUntil(() => transportA.meta !== null)
    const sid = transportA.meta!.sessionId
    await waitUntil(() => partChunkCount(sinkB, 0, 0) >= CHUNKS_PER_BLOCK)
    ac.abort()
    transportA.drain() // 让发送循环退出
    // T08：取消/中断 → sender 抛 AbortError（不再静默返回），未完成文件不标记 done
    await expect(run1).rejects.toMatchObject({ name: 'AbortError' })
    transportA.pauseAfter = null // 第二轮不再背压暂停

    // 第二轮：重连（同 sessionId）→ 只补块 1（chunk 256..299）
    const framesBefore = transportA.sent.length
    await a.resumeSend()
    const chunks2 = transportA.sent
      .slice(framesBefore)
      .filter((s) => s.kind === 'chunk')
      .map((s) => s.chunkIndex!)
    expect(chunks2).toEqual(Array.from({ length: 300 - CHUNKS_PER_BLOCK }, (_, i) => CHUNKS_PER_BLOCK + i))

    // B 完成 part：真实字节与源一致（SHA-256 一致）
    await waitUntil(() => sinkB.finalized.includes(`${sid}:0:0`))
    await expect(sha256Hex(sinkB.mergePart(sid, 0, 0))).resolves.toBe(await sha256Hex(bytes))
    void b
  })

  it('接收端重载恢复：新实例从 store 按 sessionId 恢复，只补缺失', async () => {
    const { a, sinkB, store, transportA } = pair()
    const { file, bytes } = bigSource()
    const ac = new AbortController()

    transportA.pauseAfter = 1 + CHUNKS_PER_BLOCK
    const run1 = a.startSend([file], ac.signal)
    await waitUntil(() => transportA.meta !== null)
    const sid = transportA.meta!.sessionId
    await waitUntil(() => partChunkCount(sinkB, 0, 0) >= CHUNKS_PER_BLOCK)
    ac.abort()
    transportA.drain()
    await expect(run1).rejects.toMatchObject({ name: 'AbortError' })
    transportA.pauseAfter = null // 第二轮不再背压暂停
    await new Promise((r) => setTimeout(r, 2100)) // 等节流持久化落盘
    expect(store.records.size).toBe(1)

    // 接收端「重载」：新 controller + 同一 store/磁盘，链路重指向 b2
    const b2 = makeReceiver(sinkB, store, (f) => a.handleData(f.buffer as ArrayBuffer))
    transportA.setTarget((f) => b2.handleData(f.buffer as ArrayBuffer))

    const framesBefore = transportA.sent.length
    await a.resumeSend()
    const chunks2 = transportA.sent
      .slice(framesBefore)
      .filter((s) => s.kind === 'chunk')
      .map((s) => s.chunkIndex!)
    expect(chunks2).toHaveLength(300 - CHUNKS_PER_BLOCK)
    expect(chunks2[0]).toBe(CHUNKS_PER_BLOCK)
    await waitUntil(() => sinkB.finalized.includes(`${sid}:0:0`))
    await expect(sha256Hex(sinkB.mergePart(sid, 0, 0))).resolves.toBe(await sha256Hex(bytes))
  })

  it('发送端重载：新 controller 新 sessionId，按 name+size 匹配已收会话，只补缺失', async () => {
    const store = new FakeResumeStore()
    const sinkB = new MemorySink()
    // 接收端 b（带 store），其发出的消息路由到当前发送端
    let senderTarget: (f: Uint8Array) => void = () => {}
    const b = makeReceiver(sinkB, store, (f) => senderTarget(f))
    const events = noopEvents()

    // 第一轮发送端 a1：meta + 块 0 后背压暂停 → 断连
    const sent1: SentFrame[] = []
    const t1 = pacedTransport(sent1, (f) => b.handleData(f.buffer as ArrayBuffer), 1 + CHUNKS_PER_BLOCK)
    const a1 = makeSender(t1, events)
    senderTarget = (f) => a1.handleData(f.buffer as ArrayBuffer)
    const ac = new AbortController()
    const { file, bytes } = bigSource()
    const p1 = a1.startSend([file], ac.signal)
    await waitUntil(() => t1.meta !== null)
    const sid = t1.meta!.sessionId
    await waitUntil(() => partChunkCount(sinkB, 0, 0) >= CHUNKS_PER_BLOCK)
    ac.abort()
    t1.drain()
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    t1.pauseAfter = null // 第二轮不再背压暂停
    await new Promise((r) => setTimeout(r, 2100))
    expect(store.records.size).toBe(1)

    // 发送端「重载」：新 controller A2（新 sessionId），重新选同一文件 → name+size 匹配
    const sent2: SentFrame[] = []
    const a2 = makeSender(
      {
        send: (f) => {
          const chunk = parseChunk(f)
          sent2.push(chunk ? { kind: 'chunk', chunkIndex: chunk.chunkIndex } : { kind: 'control' })
          b.handleData(f.buffer as ArrayBuffer)
        },
        bufferedAmount: 0,
        onBufferedAmountLow: () => () => {},
      },
      events,
    )
    senderTarget = (f) => a2.handleData(f.buffer as ArrayBuffer)
    const { file: file2 } = bigSource()
    await a2.startSend([file2])
    const chunks2 = sent2.filter((s) => s.kind === 'chunk').map((s) => s.chunkIndex!)
    expect(chunks2).toHaveLength(300 - CHUNKS_PER_BLOCK)
    expect(chunks2[0]).toBe(CHUNKS_PER_BLOCK)
    await waitUntil(() => sinkB.finalized.includes(`${sid}:0:0`))
    await expect(sha256Hex(sinkB.mergePart(sid, 0, 0))).resolves.toBe(await sha256Hex(bytes))
  })

  it('part 校验失败：B 清位图 + part_reset → 重发 → 最终字节一致', async () => {
    const { a, transportA, sinkB } = pair({ failOnce: true })
    const { file, bytes } = bigSource(CHUNK_SIZE * 2) // 小文件（2 chunk，1 块）
    const p = a.startSend([file])
    await waitUntil(() => transportA.meta !== null)
    const sid = transportA.meta!.sessionId
    await p
    await waitUntil(() => sinkB.finalized.length >= 2) // 第 1 次失败 + 第 2 次成功
    await expect(sha256Hex(sinkB.mergePart(sid, 0, 0))).resolves.toBe(await sha256Hex(bytes))
  })

  it('位图持久化节流 ≤2s：块完成后延迟落盘', async () => {
    vi.useFakeTimers()
    try {
      const { a, b, sinkB, store, transportA } = pair()
      const { file } = bigSource(CHUNK_SIZE * CHUNKS_PER_BLOCK) // 恰好 1 块
      transportA.pauseAfter = 1 + CHUNKS_PER_BLOCK
      const p = a.startSend([file])
      // fake 时钟下轮询：advanceTimersByTimeAsync 同时 flush 微任务
      for (let i = 0; i < 20_000 && partChunkCount(sinkB, 0, 0) < CHUNKS_PER_BLOCK; i++) {
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(partChunkCount(sinkB, 0, 0)).toBe(CHUNKS_PER_BLOCK)
      transportA.drain()
      await p
      // 未到节流周期（fake 时钟仍接近 0）：不落盘
      expect(store.records.size).toBe(0)
      await vi.advanceTimersByTimeAsync(1999)
      expect(store.records.size).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(store.records.size).toBe(1)
      const rec = store.records.get([...store.records.keys()][0])!
      expect(rec.files[0].parts?.[0].state).toBe('partial')
      void b
    } finally {
      vi.useRealTimers()
    }
  })
})
