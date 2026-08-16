/**
 * opfsExport —— 主线程 OPFS 异步读（导出路径零拷贝/流式，T23）。
 *
 * 接收写入在 storage worker（sync access handle，iOS 限制必须 worker）；OPFS 是
 * origin 级共享存储，主线程用异步 API（navigator.storage.getDirectory →
 * getFileHandle().getFile()）直接读同一布局的已拼接文件：
 *   - getFile() 返回磁盘背书的 File（O(1)，不拷贝进 JS 堆）
 *   - File.stream() 流式读，配合 OPFS/FSA createWritable 管道零驻留
 * 导出不再走 readMerged（整文件读进 JS 堆 → 700MB 级内存爆，T23 根因）。
 *
 * 仅导出路径使用；接收写入路径不变（worker sync handle）。
 * 最小结构接口（OpfsDirLike）便于单测注入 fake；生产默认取 navigator.storage。
 */

import type { ZipChunkSink } from '../transfer/zip'
import { mergedPath } from './engine'

/** 最小目录句柄结构（FileSystemDirectoryHandle 结构兼容，测试可注入 fake） */
export interface OpfsDirLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirLike>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileLike>
}

export interface OpfsFileLike {
  getFile(): Promise<File>
  createWritable(): Promise<FileSystemWritableFileStream>
}

export type GetDirectory = () => Promise<OpfsDirLike>

const defaultGetDirectory: GetDirectory = () => navigator.storage.getDirectory()

/** 打开已拼接文件 → 磁盘背书 File（merge 前置由调用方保证；路径缺失抛错） */
export async function opfsMergedFile(
  sessionId: string,
  fileId: number,
  name: string,
  getDirectory: GetDirectory = defaultGetDirectory,
): Promise<File> {
  const segments = mergedPath(sessionId, fileId, name).split('/')
  let dir = await getDirectory()
  for (const seg of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(seg)
  }
  const last = segments[segments.length - 1]
  return (await dir.getFileHandle(last)).getFile()
}

/**
 * 在 OPFS exports/ 临时目录流式写文件（如 zip）→ 返回磁盘背书 File。
 * 可下载（objectURL）或分享（navigator.share），全程零驻留；失败时关闭 writable 并抛错。
 */
export async function withOpfsTempFile<T>(
  fileName: string,
  write: (writable: FileSystemWritableFileStream) => Promise<T>,
  getDirectory: GetDirectory = defaultGetDirectory,
): Promise<{ result: T; file: File }> {
  const root = await getDirectory()
  const tmp = await root.getDirectoryHandle('exports', { create: true })
  const handle = await tmp.getFileHandle(fileName, { create: true })
  const writable = await handle.createWritable()
  try {
    const result = await write(writable)
    await writable.close()
    return { result, file: await handle.getFile() }
  } catch (e) {
    await writable.close().catch(() => {})
    throw e
  }
}

/**
 * zip 流式输出 sink：chunk 累积到阈值（默认 4 MiB）统一 flush，串行写 writable，
 * 返回 promise 供背压（zip 写入器 await）。final=true 时强制 flush 全部。
 */
export function writableChunkSink(
  writable: FileSystemWritableFileStream,
  flushAt = 4 * 1024 * 1024,
): ZipChunkSink {
  let batch: Uint8Array<ArrayBuffer>[] = []
  let bytes = 0
  let chain: Promise<void> = Promise.resolve()
  return (chunk, final) => {
    if (chunk.byteLength > 0) {
      batch.push(chunk)
      bytes += chunk.byteLength
    }
    if (!final && bytes < flushAt) return Promise.resolve()
    if (batch.length === 0) return Promise.resolve()
    const flush = batch
    batch = []
    bytes = 0
    chain = chain.then(async () => {
      for (const c of flush) await writable.write(c)
    })
    return chain
  }
}
