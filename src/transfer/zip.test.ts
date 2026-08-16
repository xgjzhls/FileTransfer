/**
 * zip.ts —— deflate 压缩 zip 写入器单测。
 * 回读用 fflate 的 unzipSync（与生产同库，验证打包/解包对称）；
 * 另验证压缩生效（可压缩内容 zip 显著变小）与条目预检。
 */

import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { buildZip, buildZipStream, assertZipEntries, crc32, ZIP_MAX_ENTRY_BYTES, ZIP_LEVEL } from './zip'
import type { ZipEntry, ZipLevel, ZipStreamEntry } from './zip'

function entry(path: string, content: string | Uint8Array): ZipEntry {
  const raw = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return { path, data: new Uint8Array(raw) } // 复制为 ArrayBuffer 支撑（TS7 typed array）
}

/** 打包并解回 → {name: data} 映射 */
async function roundTrip(entries: ZipEntry[], level?: ZipLevel): Promise<Map<string, Uint8Array>> {
  const blob = await buildZip(entries, level)
  expect(blob.type).toBe('application/zip')
  const out = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  return new Map(Object.entries(out))
}

describe('buildZip — deflate 压缩 + 结构回读（SPEC §4 文件夹导出）', () => {
  it('空条目：合法空 zip', async () => {
    expect((await roundTrip([])).size).toBe(0)
  })

  it('单文件：名称/数据一致', async () => {
    const m = await roundTrip([entry('a.txt', 'hello zip')])
    expect([...m.keys()]).toEqual(['a.txt'])
    expect(new TextDecoder().decode(m.get('a.txt')!)).toBe('hello zip')
  })

  it('嵌套目录 + 多文件：相对路径完整保留', async () => {
    const m = await roundTrip([
      entry('photos/2024/img.jpg', 'jpeg-bytes'),
      entry('photos/readme.txt', 'readme'),
      entry('docs/a/b/c.txt', 'deep'),
    ])
    expect([...m.keys()]).toEqual(['photos/2024/img.jpg', 'photos/readme.txt', 'docs/a/b/c.txt'])
    expect(new TextDecoder().decode(m.get('docs/a/b/c.txt')!)).toBe('deep')
  })

  it('中文（UTF-8）文件名可回读', async () => {
    const m = await roundTrip([entry('照片/旅行/雪景.jpg', 'x')])
    expect([...m.keys()]).toEqual(['照片/旅行/雪景.jpg'])
  })

  it('二进制数据（含 0x00 与高位字节）逐字节一致', async () => {
    const data = new Uint8Array([0, 1, 2, 0x80, 0xff, 0x00, 0x7f])
    const m = await roundTrip([entry('bin.dat', data)])
    expect([...m.get('bin.dat')!]).toEqual([...data])
  })

  it('压缩生效：可压缩内容（重复文本）zip 显著小于原文', async () => {
    const big = '重复内容重复内容重复内容重复内容重复内容重复内容重复内容'.repeat(5000)
    const blob = await buildZip([entry('docs/notes.txt', big)])
    expect(blob.size).toBeLessThan(big.length / 3) // deflate 压缩率显著（>3x）
  })

  it('不可压缩内容（真随机）：体积基本持平（deflate 开销很小）', async () => {
    const data = new Uint8Array(200_000)
    for (let i = 0; i < data.length; i += 65536) {
      crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)))
    }
    const blob = await buildZip([entry('rand.bin', data)])
    expect(blob.size).toBeLessThan(data.length + 2000) // 含头开销，但不超过 ~2KB 冗余
    expect(blob.size).toBeGreaterThan(data.length * 0.95)
  })

  it('level 0（store）≈ 原大小；level 6（默认）压缩更小', async () => {
    const big = 'compressible '.repeat(20000)
    const store = await buildZip([entry('a.txt', big)], 0)
    const deflated = await buildZip([entry('a.txt', big)])
    expect(deflated.size).toBeLessThan(store.size)
  })

  it('ZIP_LEVEL 默认 6（均衡档）', () => {
    expect(ZIP_LEVEL).toBe(6)
  })
})

describe('crc32 — 标准 CRC-32（zlib 同款）', () => {
  it('已知向量："123456789" → 0xCBF43926', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('增量与一次性一致', () => {
    const a = new TextEncoder().encode('hello ')
    const b = new TextEncoder().encode('world')
    const once = crc32(concatBytes([a, b]))
    const incr = crc32(b, crc32(a))
    expect(incr).toBe(once)
  })

  it('空输入 = 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

async function* chunkStream(data: Uint8Array, step = 7): AsyncGenerator<Uint8Array> {
  // 每块独立拷贝（与 Blob.stream() 语义一致：AsyncDeflate 会 transfer 块 buffer，共享 buffer 会被 detach）
  for (let i = 0; i < data.length; i += step) {
    const view = data.subarray(i, Math.min(i + step, data.length))
    const copy = new Uint8Array(view.length)
    copy.set(view)
    yield copy
  }
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

function streamEntry(path: string, content: string | Uint8Array, step?: number): ZipStreamEntry {
  const raw = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return { path, byteLength: raw.length, stream: chunkStream(raw, step) }
}

/** 流式打包并解回 → {name: data} 映射（与 buildZip 同回读口径） */
async function streamRoundTrip(entries: ZipStreamEntry[], level?: ZipLevel): Promise<Map<string, Uint8Array>> {
  const chunks: Uint8Array[] = []
  await buildZipStream(entries, async (c) => {
    chunks.push(c)
  }, level)
  const out = unzipSync(concatBytes(chunks))
  return new Map(Object.entries(out))
}

describe('buildZipStream — 流式 deflate zip（T23）', () => {
  it('空条目：合法空 zip', async () => {
    expect((await streamRoundTrip([])).size).toBe(0)
  })

  it('单文件：名称/数据一致（分块输入 7B）', async () => {
    const m = await streamRoundTrip([streamEntry('a.txt', 'hello streaming zip', 7)])
    expect([...m.keys()]).toEqual(['a.txt'])
    expect(new TextDecoder().decode(m.get('a.txt')!)).toBe('hello streaming zip')
  })

  it('嵌套目录 + 多文件：相对路径完整保留', async () => {
    const m = await streamRoundTrip([
      streamEntry('photos/2024/img.jpg', 'jpeg-bytes'),
      streamEntry('photos/readme.txt', 'readme'),
      streamEntry('docs/a/b/c.txt', 'deep'),
    ])
    expect([...m.keys()]).toEqual(['photos/2024/img.jpg', 'photos/readme.txt', 'docs/a/b/c.txt'])
    expect(new TextDecoder().decode(m.get('docs/a/b/c.txt')!)).toBe('deep')
  })

  it('中文（UTF-8）文件名可回读', async () => {
    const m = await streamRoundTrip([streamEntry('照片/旅行/雪景.jpg', 'x')])
    expect([...m.keys()]).toEqual(['照片/旅行/雪景.jpg'])
  })

  it('二进制数据（含 0x00 与高位字节）逐字节一致', async () => {
    const data = new Uint8Array([0, 1, 2, 0x80, 0xff, 0x00, 0x7f])
    const m = await streamRoundTrip([streamEntry('bin.dat', data)])
    expect([...m.get('bin.dat')!]).toEqual([...data])
  })

  it('空文件条目（0 字节）：合法空 deflate 流', async () => {
    const m = await streamRoundTrip([streamEntry('empty.txt', '')])
    expect(m.get('empty.txt')!.length).toBe(0)
  })

  it('与 buildZip（一次性）输出等价：同名条目内容一致', async () => {
    // 流是一次性消费的：两路各用一份新条目（async generator 不能复用）
    const makeEntries = () => [
      streamEntry('photos/2024/img.jpg', 'jpeg-bytes'),
      streamEntry('docs/notes.txt', '重复内容重复内容'.repeat(100)),
    ]
    const oneShot = await (async () => {
      const src: ZipEntry[] = []
      for (const e of makeEntries()) src.push({ path: e.path, data: await collect(e) })
      const blob = await buildZip(src)
      return new Map(Object.entries(unzipSync(new Uint8Array(await blob.arrayBuffer()))))
    })()
    const streamed = await streamRoundTrip(makeEntries())
    for (const [name, data] of oneShot) {
      expect([...streamed.get(name)!]).toEqual([...data])
    }
  })

  it('超过同步压缩阈值（>4 MiB）走 worker 异步路径：回读一致', async () => {
    const big = new TextEncoder().encode('可压缩内容可压缩内容'.repeat(200_000)) // ~4.6 MB
    const m = await streamRoundTrip([streamEntry('big/notes.txt', big, 65536)])
    expect([...m.get('big/notes.txt')!]).toEqual([...big])
  })

  it('4GiB 单条目上限在流式预检即拒绝（不产生任何 sink 输出）', async () => {
    const sink = async () => {
      throw new Error('sink 不应被调用')
    }
    await expect(
      buildZipStream([{ path: 'big.bin', byteLength: ZIP_MAX_ENTRY_BYTES + 1, stream: chunkStream(new Uint8Array(0)) }], sink),
    ).rejects.toThrow(/4GiB/)
  })
})

async function collect(e: ZipStreamEntry): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = []
  for await (const b of e.stream) parts.push(b)
  return concatBytes(parts)
}

describe('assertZipEntries — 预检', () => {
  it('4GiB 单条目上限（zip32）—— 用 fake 尺寸验证，无需分配内存', () => {
    expect(() => assertZipEntries([{ path: 'big.bin', byteLength: ZIP_MAX_ENTRY_BYTES }])).not.toThrow()
    expect(() => assertZipEntries([{ path: 'big.bin', byteLength: ZIP_MAX_ENTRY_BYTES + 1 }])).toThrow(/4GiB/)
  })

  it('拒绝不安全路径（../ 穿越等）', () => {
    expect(() => assertZipEntries([{ path: '../evil', byteLength: 1 }])).toThrow(/unsafe/)
    expect(() => assertZipEntries([{ path: '/abs', byteLength: 1 }])).toThrow(/unsafe/)
  })

  it('拒绝重复路径', () => {
    expect(() =>
      assertZipEntries([
        { path: 'a.txt', byteLength: 1 },
        { path: 'a.txt', byteLength: 2 },
      ]),
    ).toThrow(/duplicate/)
  })
})
