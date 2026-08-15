/**
 * zip.ts —— store-only zip 写入器单测。
 * 结构自解析验证（本地文件头/中央目录/CRC/偏移），并对已知向量校验 CRC-32。
 */

import { describe, expect, it } from 'vitest'
import { buildStoreZip, crc32, assertZipEntries, ZIP_MAX_ENTRY_BYTES } from './zip'
import type { ZipEntry } from './zip'

function le32(dv: DataView, at: number): number {
  return dv.getUint32(at, true)
}
function le16(dv: DataView, at: number): number {
  return dv.getUint16(at, true)
}

/** 最小 zip 解析器：走中央目录 → 本地头 → 数据，返回 {name, data}[] */
async function parseZip(blob: Blob): Promise<{ name: string; data: Uint8Array }[]> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  const dv = new DataView(buf.buffer)
  const eocd = buf.byteLength - 22 // 无注释：EOCD 恒为末 22 字节
  expect(le32(dv, eocd)).toBe(0x06054b50)
  const count = le16(dv, eocd + 10)
  let at = le32(dv, eocd + 16)
  const out: { name: string; data: Uint8Array }[] = []
  for (let i = 0; i < count; i++) {
    expect(le32(dv, at)).toBe(0x02014b50) // 中央目录头
    const nameLen = le16(dv, at + 28)
    const size = le32(dv, at + 24)
    const compSize = le32(dv, at + 20)
    const crc = le32(dv, at + 16)
    const localAt = le32(dv, at + 42)
    expect(compSize).toBe(size) // store：压缩=未压缩
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen))
    // 本地文件头
    expect(le32(dv, localAt)).toBe(0x04034b50)
    const lNameLen = le16(dv, localAt + 26)
    const lMethod = le16(dv, localAt + 8)
    expect(lMethod).toBe(0)
    const data = new Uint8Array(buf.subarray(localAt + 30 + lNameLen, localAt + 30 + lNameLen + size))
    expect(crc32(data)).toBe(crc)
    out.push({ name, data })
    at += 46 + nameLen
  }
  return out
}

function entry(path: string, content: string): ZipEntry {
  return { path, data: new Uint8Array(new TextEncoder().encode(content)) }
}

describe('crc32 — 已知向量（IEEE 802.3）', () => {
  it('标准向量', () => {
    expect(crc32(new Uint8Array())).toBe(0x00000000)
    expect(crc32(new TextEncoder().encode('a'))).toBe(0xe8b7be43)
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('buildStoreZip — 结构自解析回读（SPEC §4 文件夹导出）', () => {
  it('空条目：合法空 zip（仅 EOCD）', async () => {
    const entries = await parseZip(buildStoreZip([]))
    expect(entries).toEqual([])
  })

  it('单文件：名称/数据/CRC 一致', async () => {
    const blob = buildStoreZip([entry('a.txt', 'hello zip')])
    expect(blob.type).toBe('application/zip')
    const entries = await parseZip(blob)
    expect(entries).toEqual([{ name: 'a.txt', data: new TextEncoder().encode('hello zip') }])
  })

  it('嵌套目录 + 多文件：相对路径完整保留，本地偏移连续', async () => {
    const entries = [
      entry('photos/2024/img.jpg', 'jpeg-bytes'),
      entry('photos/readme.txt', 'readme'),
      entry('docs/a/b/c.txt', 'deep'),
    ]
    const parsed = await parseZip(buildStoreZip(entries))
    expect(parsed.map((e) => e.name)).toEqual(['photos/2024/img.jpg', 'photos/readme.txt', 'docs/a/b/c.txt'])
    expect(new TextDecoder().decode(parsed[0].data)).toBe('jpeg-bytes')
    expect(new TextDecoder().decode(parsed[2].data)).toBe('deep')
  })

  it('中文（UTF-8）文件名可回读', async () => {
    const parsed = await parseZip(buildStoreZip([entry('照片/旅行/雪景.jpg', 'x')]))
    expect(parsed[0].name).toBe('照片/旅行/雪景.jpg')
  })

  it('二进制数据（含 0x00 与高位字节）CRC 与数据一致', async () => {
    const data = new Uint8Array([0, 1, 2, 0x80, 0xff, 0x00, 0x7f])
    const parsed = await parseZip(buildStoreZip([{ path: 'bin.dat', data }]))
    expect([...parsed[0].data]).toEqual([...data])
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
