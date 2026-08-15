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

import { zip } from 'fflate'
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

/** 打包 deflate zip → Blob（worker 异步，大文件夹不冻结主线程） */
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
