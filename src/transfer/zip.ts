/**
 * zip.ts —— deflate 压缩 zip 写入器（接收端文件夹导出，SPEC §4）。
 *
 * 目录树保持：接收端把整棵目录树（文件 name 为相对路径）打包成单个 zip，
 * 一次分享/下载/导出到指定文件夹；目标端 iOS「文件」App 原生可解压，
 * 结构 100% 保留。
 *
 * 压缩：fflate（纯 JS、零运行时依赖，随 PWA 打包）deflate level 6 ——
 * 「均衡」档：照片/视频本已压缩收益小但开销低，文本/文档类显著变小。
 * （T18 曾用 store 不压缩；T19 按用户要求改为均衡压缩，速度与压缩率兼顾）
 *
 * 异步：用 fflate 的 worker 版 `zip`，1GiB 级打包不阻塞主线程（UI 不冻结）。
 *
 * 约束：
 * - 单条目 ≤ 4GiB（zip32 上限；超限抛错，UI 提示逐文件导出）
 * - 条目名 UTF-8（fflate 默认 UTF-8 文件名）；路径必须安全相对路径（isSafeRelPath）
 * - 不处理 zip64 / 加密 / 目录条目（空目录不保留——与 OPFS 存储语义一致）
 */

import { zip, AsyncDeflate, Deflate } from 'fflate'
import { isSafeRelPath } from '../storage/path'

export const ZIP_MIME = 'application/zip'
/** zip32 单条目上限（4GiB - 1） */
export const ZIP_MAX_ENTRY_BYTES = 0xffffffff
/** deflate 压缩档位：6 = 均衡（速度与压缩率兼顾） */
export const ZIP_LEVEL = 6

export interface ZipEntry {
  /** zip 内相对路径（/ 分隔，与传输 meta 的 name 一致） */
  path: string
  /** 文件字节（引擎 readMerged 返回 ArrayBuffer 支撑的视图，生产路径恒如此） */
  data: Uint8Array<ArrayBuffer>
}

/**
 * 流式 zip 条目（T23）：byteLength 供预检（4GiB/重名/安全路径），
 * stream 为条目字节流（生产 = OPFS 磁盘背书 File.stream()；测试 = 内存分块）。
 */
export interface ZipStreamEntry {
  path: string
  stream: AsyncIterable<Uint8Array>
  byteLength: number
}

/**
 * 流式输出 sink：resolve 表示该 chunk 已被消费（写盘/缓冲），供背压；
 * final=true 表示 zip 已写完（sink 应 flush 并返回完成 promise）。
 * chunk 恒为 ArrayBuffer 背书（fflate 输出与自建头均如此），便于直接写 FSA/OPFS。
 */
export type ZipChunkSink = (chunk: Uint8Array<ArrayBuffer>, final: boolean) => Promise<void>

/** fflate deflate 档位（0=store，6=均衡默认） */
export type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** 条目预检（独立纯函数便于单测 4GiB 上限，无需真分配 4GiB 内存） */
export function assertZipEntries(entries: { path: string; byteLength: number }[]): void {
  const names = new Set<string>()
  for (const e of entries) {
    if (!isSafeRelPath(e.path)) throw new Error(`unsafe zip entry path: ${JSON.stringify(e.path)}`)
    if (e.byteLength > ZIP_MAX_ENTRY_BYTES) {
      throw new Error(`zip 单文件超过 4GiB 上限：${e.path}（请逐文件导出）`)
    }
    if (names.has(e.path)) throw new Error(`duplicate zip entry: ${e.path}`)
    names.add(e.path)
  }
}

/** 打包 deflate zip → Blob（worker 异步，大文件夹不冻结主线程；T23 后仅测试/降级参考） */
export async function buildZip(entries: ZipEntry[], level: ZipLevel = ZIP_LEVEL): Promise<Blob> {
  assertZipEntries(entries.map((e) => ({ path: e.path, byteLength: e.data.byteLength })))
  const files: Record<string, Uint8Array> = {}
  for (const e of entries) files[e.path] = e.data
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level }, (err, out) => (err ? reject(err) : resolve(out)))
  })
  // fflate 输出为全新分配（ArrayBuffer 支撑），Blob 直接引用；cast 安全
  return new Blob([bytes as unknown as BlobPart], { type: ZIP_MIME })
}

/*
 * ─── T23 流式 zip 写入器 ───
 *
 * fflate 的 `Zip` 类会把单条目全部压缩输出攒到 final 才吐出（chks_1 缓冲），
 * 不适合大文件流式；此处自写标准 zip 写入器（数据描述符 bit3 + UTF-8 bit11）：
 *   本地头（占位 crc/尺寸）→ 流式 deflate（AsyncDeflate worker / 小条目同步
 *   Deflate）→ 数据描述符（真实 crc/尺寸）→ 中央目录 + EOCD。
 * 输入分块喂入、输出分块写 sink，内存恒定；crc32 自实现（fflate 未导出）。
 */

/** 小条目同步压缩阈值：≤ 此值走主线程 Deflate（避免每条目起 worker，多小文件场景） */
const SYNC_DEFLATE_MAX_BYTES = 4 * 1024 * 1024
/** 异步 worker 输入队列背压上限（queuedSize 未处理字节） */
const ASYNC_QUEUE_MAX_BYTES = 8 * 1024 * 1024

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_DESCRIPTOR = 0x08074b50
const SIG_EOCD = 0x06054b50
/** bit3 数据描述符 + bit11 UTF-8 文件名 */
const FLAGS_STREAMING = 0x0808
const METHOD_DEFLATE = 8
/** DOS 日期 1980-01-01（合法最小） */
const DOS_DATE = 0x21
const ZIP_VER = 20

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** 标准 CRC-32（zlib 同款算法）：seed 传上一次结果（首次 0），返回累计值 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

function w16(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff
  out[off + 1] = (v >>> 8) & 0xff
}

function w32(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff
  out[off + 1] = (v >>> 8) & 0xff
  out[off + 2] = (v >>> 16) & 0xff
  out[off + 3] = (v >>> 24) & 0xff
}

/** 本地文件头（30B + 名；crc/尺寸占位，真实值在数据描述符） */
function localHeaderBytes(name: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(30 + name.length)
  w32(out, 0, SIG_LOCAL)
  w16(out, 4, ZIP_VER)
  w16(out, 6, FLAGS_STREAMING)
  w16(out, 8, METHOD_DEFLATE)
  w16(out, 10, 0)
  w16(out, 12, DOS_DATE)
  w32(out, 14, 0) // crc 占位
  w32(out, 18, 0) // csize 占位
  w32(out, 22, 0) // usize 占位
  w16(out, 26, name.length)
  w16(out, 28, 0)
  out.set(name, 30)
  return out
}

/** 数据描述符（16B，紧跟在压缩数据后） */
function descriptorBytes(crc: number, csize: number, usize: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(16)
  w32(out, 0, SIG_DESCRIPTOR)
  w32(out, 4, crc)
  w32(out, 8, csize)
  w32(out, 12, usize)
  return out
}

/** 中央目录条目（46B + 名） */
function centralEntryBytes(
  name: Uint8Array,
  crc: number,
  csize: number,
  usize: number,
  localOffset: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(46 + name.length)
  w32(out, 0, SIG_CENTRAL)
  w16(out, 4, ZIP_VER)
  w16(out, 6, ZIP_VER)
  w16(out, 8, FLAGS_STREAMING)
  w16(out, 10, METHOD_DEFLATE)
  w16(out, 12, 0)
  w16(out, 14, DOS_DATE)
  w32(out, 16, crc)
  w32(out, 20, csize)
  w32(out, 24, usize)
  w16(out, 28, name.length)
  w16(out, 30, 0)
  w16(out, 32, 0)
  w16(out, 34, 0)
  w16(out, 36, 0)
  w32(out, 38, 0)
  w32(out, 42, localOffset)
  out.set(name, 46)
  return out
}

/** 中央目录结束记录（22B） */
function endRecordBytes(count: number, centralSize: number, centralOffset: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(22)
  w32(out, 0, SIG_EOCD)
  w16(out, 4, 0)
  w16(out, 6, 0)
  w16(out, 8, count)
  w16(out, 10, count)
  w32(out, 12, centralSize)
  w32(out, 16, centralOffset)
  w16(out, 20, 0)
  return out
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * 流式 deflate 单个条目 → 统计（crc/csize/usize）。
 * 小条目（≤ SYNC_DEFLATE_MAX_BYTES）用同步 Deflate（避免每条目起 worker，
 * 主线程停顿 ≤ 数十 ms/条目）；大条目用 AsyncDeflate（worker，ondrain 背压
 * 限队列）+ sink 链背压，内存恒定。
 */
async function deflateEntry(
  entry: ZipStreamEntry,
  level: ZipLevel,
  emit: (dat: Uint8Array<ArrayBuffer>) => Promise<void>,
): Promise<{ crc: number; csize: number; usize: number }> {
  let crc = 0
  let usize = 0
  let csize = 0
  let error: Error | null = null
  let pending: Promise<void> = Promise.resolve()
  const toSink = (dat: Uint8Array<ArrayBuffer>) => {
    csize += dat.length
    pending = pending.then(() => emit(dat)).catch((e) => {
      error = error ?? (e instanceof Error ? e : new Error(String(e)))
    })
  }

  if (entry.byteLength <= SYNC_DEFLATE_MAX_BYTES) {
    // 同步 Deflate 回调签名 (data, final) —— 无 err 参数（FlateStreamHandler）
    const def = new Deflate({ level }, (dat) => toSink(dat))
    for await (const block of entry.stream) {
      crc = crc32(block, crc)
      usize += block.length
      def.push(block, false)
      await pending
      if (error) throw error
    }
    def.push(new Uint8Array(0), true)
    await pending
    if (error) throw error
    return { crc, csize, usize }
  }

  // 异步（worker）路径
  let resolveFinal: (() => void) | null = null
  const finalDone = new Promise<void>((r) => {
    resolveFinal = r
  })
  let drainWaiters: (() => void)[] = []
  const drained = () => new Promise<void>((r) => drainWaiters.push(r))
  const def = new AsyncDeflate({ level }, (err, dat, final) => {
    if (err) error = error ?? new Error(err.message)
    else toSink(dat)
    if (final) resolveFinal?.()
  })
  def.ondrain = () => {
    const w = drainWaiters
    drainWaiters = []
    for (const r of w) r()
  }
  try {
    for await (const block of entry.stream) {
      crc = crc32(block, crc)
      usize += block.length
      while (def.queuedSize > ASYNC_QUEUE_MAX_BYTES) await drained()
      def.push(block, false)
      if (error) throw error
    }
    def.push(new Uint8Array(0), true)
    await finalDone
    await pending
  } finally {
    def.terminate()
  }
  if (error) throw error
  return { crc, csize, usize }
}

/**
 * 流式 deflate zip（T23）：逐条目流式压缩写 sink，内存恒定（不整包驻留），
 * 与 buildZip 输出等价（结构/名称/内容，可回读验证）。
 */
export async function buildZipStream(
  entries: ZipStreamEntry[],
  sink: ZipChunkSink,
  level: ZipLevel = ZIP_LEVEL,
): Promise<void> {
  assertZipEntries(entries.map((e) => ({ path: e.path, byteLength: e.byteLength })))

  const central: Uint8Array<ArrayBuffer>[] = []
  let centralSize = 0
  let offset = 0

  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.path)
    const localOffset = offset
    const header = localHeaderBytes(nameBytes)
    await sink(header, false)
    offset += header.length

    const stats = await deflateEntry(e, level, (dat) => sink(dat, false))
    const descriptor = descriptorBytes(stats.crc, stats.csize, stats.usize)
    await sink(descriptor, false)
    offset += stats.csize + descriptor.length

    const cent = centralEntryBytes(nameBytes, stats.crc, stats.csize, stats.usize, localOffset)
    central.push(cent)
    centralSize += cent.length
  }

  const end = endRecordBytes(entries.length, centralSize, offset)
  await sink(concatBytes([...central, end]), true)
}
