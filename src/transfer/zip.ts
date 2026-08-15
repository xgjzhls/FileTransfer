/**
 * zip.ts —— store-only（不压缩）zip 写入器（接收端文件夹导出，SPEC §4）。
 *
 * 目录树保持：接收端把整棵目录树（文件 name 为相对路径）打包成单个 zip，
 * 一次分享/下载；目标端 iOS「文件」App 原生可解压，结构 100% 保留。
 *
 * 只做 method=0 store（不压缩，用户已拍板）：
 * - 文件夹场景以照片/视频为主，本就已压缩，store 体积无差且更快；
 * - 零依赖、约 150 行，全量单测可锁定；文本/文档类小文件 zip 会偏大（可接受）。
 *
 * 约束：
 * - 单条目 ≤ 4GiB（zip32 上限；超限抛错，UI 提示逐文件导出）
 * - 条目名 UTF-8（GP bit 11，中文名必需）；路径必须是安全相对路径（isSafeRelPath）
 * - 不处理 zip64 / 加密 / 目录条目（空目录不保留——与 OPFS 存储语义一致）
 */

import { isSafeRelPath } from '../storage/path'

export const ZIP_MIME = 'application/zip'
/** zip32 单条目上限（4GiB - 1） */
export const ZIP_MAX_ENTRY_BYTES = 0xffffffff

export interface ZipEntry {
  /** zip 内相对路径（/ 分隔，与传输 meta 的 name 一致） */
  path: string
  /** 文件字节（引擎 readMerged 返回 ArrayBuffer 支撑的视图，生产路径恒如此） */
  data: Uint8Array<ArrayBuffer>
}

/** CRC-32（IEEE 802.3，zip/PNG 标准）—— 查表实现，无依赖 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 固定 DOS 时间（1980-01-01 00:00:00）—— 输出确定性，便于测试比对 */
const DOS_TIME = 0
const DOS_DATE = 0x21

const LOCAL_HDR = 0x04034b50
const CENTRAL_HDR = 0x02014b50
const EOCD_HDR = 0x06054b50
/** GP bit 11：文件名 UTF-8（系统解压中文名必需） */
const GP_UTF8 = 0x0800

function le32(v: number, out: Uint8Array, at: number): void {
  out[at] = v & 0xff
  out[at + 1] = (v >>> 8) & 0xff
  out[at + 2] = (v >>> 16) & 0xff
  out[at + 3] = (v >>> 24) & 0xff
}

function le16(v: number, out: Uint8Array, at: number): void {
  out[at] = v & 0xff
  out[at + 1] = (v >>> 8) & 0xff
}

/** 条目预检（独立纯函数便于单测 4GiB 上限，无需真分配 4GiB 内存） */
export function assertZipEntries(entries: { path: string; byteLength: number }[]): void {  const names = new Set<string>()
  for (const e of entries) {
    if (!isSafeRelPath(e.path)) throw new Error(`unsafe zip entry path: ${JSON.stringify(e.path)}`)
    if (e.byteLength > ZIP_MAX_ENTRY_BYTES) {
      throw new Error(`zip 单文件超过 4GiB 上限：${e.path}（请逐文件导出）`)
    }
    if (names.has(e.path)) throw new Error(`duplicate zip entry: ${e.path}`)
    names.add(e.path)
  }
}

/** 打包 store zip → Blob（parts 组装，不整块拷贝；总内存≈全部条目字节，UI 侧有大文件守卫） */
export function buildStoreZip(entries: ZipEntry[]): Blob {
  assertZipEntries(entries.map((e) => ({ path: e.path, byteLength: e.data.byteLength })))

  const parts: BlobPart[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = new Uint8Array(new TextEncoder().encode(e.path))
    const crc = crc32(e.data)
    const size = e.data.byteLength

    const local = new Uint8Array(30)
    le32(LOCAL_HDR, local, 0)
    le16(20, local, 4) // version needed
    le16(GP_UTF8, local, 6)
    le16(0, local, 8) // method = store
    le16(DOS_TIME, local, 10)
    le16(DOS_DATE, local, 12)
    le32(crc, local, 14)
    le32(size, local, 18) // compressed = uncompressed
    le32(size, local, 22)
    le16(nameBytes.byteLength, local, 26)
    le16(0, local, 28) // extra len

    const cen = new Uint8Array(46)
    le32(CENTRAL_HDR, cen, 0)
    le16(20, cen, 4) // version made by
    le16(20, cen, 6) // version needed
    le16(GP_UTF8, cen, 8)
    le16(0, cen, 10) // method
    le16(DOS_TIME, cen, 12)
    le16(DOS_DATE, cen, 14)
    le32(crc, cen, 16)
    le32(size, cen, 20)
    le32(size, cen, 24)
    le16(nameBytes.byteLength, cen, 28)
    le16(0, cen, 30) // extra len
    le16(0, cen, 32) // comment len
    le16(0, cen, 34) // disk number
    le16(0, cen, 36) // internal attrs
    le32(0, cen, 38) // external attrs
    le32(offset, cen, 42) // local header offset

    parts.push(local, nameBytes, e.data)
    central.push(cen, nameBytes)
    offset += 30 + nameBytes.byteLength + size
  }

  const centralSize = central.reduce((s, b) => s + b.byteLength, 0)
  const eocd = new Uint8Array(22)
  le32(EOCD_HDR, eocd, 0)
  le16(0, eocd, 4) // disk 0
  le16(0, eocd, 6) // cd start disk
  le16(entries.length, eocd, 8)
  le16(entries.length, eocd, 10)
  le32(centralSize, eocd, 12)
  le32(offset, eocd, 16) // cd offset = 末尾（最后一条 local data 之后）
  le16(0, eocd, 20) // comment

  parts.push(...central, eocd)
  return new Blob(parts, { type: ZIP_MIME })
}
