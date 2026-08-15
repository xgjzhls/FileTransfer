/**
 * zip.ts —— deflate 压缩 zip 写入器单测。
 * 回读用 fflate 的 unzipSync（与生产同库，验证打包/解包对称）；
 * 另验证压缩生效（可压缩内容 zip 显著变小）与条目预检。
 */

import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { buildZip, assertZipEntries, ZIP_MAX_ENTRY_BYTES, ZIP_LEVEL } from './zip'
import type { ZipEntry, ZipLevel } from './zip'

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
