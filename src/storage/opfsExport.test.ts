/**
 * opfsExport —— 主线程 OPFS 读模块单测（T23）。
 * OPFS 句柄不可用 fake 目录树注入（OpfsDirLike 最小结构接口）。
 */

import { describe, expect, it } from 'vitest'
import { opfsMergedFile, withOpfsTempFile, writableChunkSink } from './opfsExport'
import type { OpfsDirLike, OpfsFileLike } from './opfsExport'

class FakeWritable {
  chunks: Uint8Array[] = []
  closed = false
  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk)
  }
  async close(): Promise<void> {
    this.closed = true
  }
  concat(): Uint8Array<ArrayBuffer> {
    let total = 0
    for (const c of this.chunks) total += c.length
    const out = new Uint8Array(total)
    let at = 0
    for (const c of this.chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }
}

class FakeFileHandle implements OpfsFileLike {
  readonly writable = new FakeWritable()
  private readonly fileName: string
  constructor(fileName: string) {
    this.fileName = fileName
  }
  async getFile(): Promise<File> {
    return new File([this.writable.concat()], this.fileName)
  }
  async createWritable(): Promise<FileSystemWritableFileStream> {
    return this.writable as unknown as FileSystemWritableFileStream
  }
}

class FakeDir implements OpfsDirLike {
  private dirs = new Map<string, FakeDir>()
  private files = new Map<string, FakeFileHandle>()
  readonly name: string
  constructor(name: string) {
    this.name = name
  }

  /** 测试用：预置子目录 */
  addDir(name: string): FakeDir {
    const d = new FakeDir(name)
    this.dirs.set(name, d)
    return d
  }

  /** 测试用：预置文件 */
  addFile(name: string): FakeFileHandle {
    const f = new FakeFileHandle(name)
    this.files.set(name, f)
    return f
  }

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    const existing = this.dirs.get(name)
    if (existing) return Promise.resolve(existing)
    if (options?.create) return Promise.resolve(this.addDir(name))
    return Promise.reject(new DOMException(`dir not found: ${name}`, 'NotFoundError'))
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.files.get(name)
    if (existing) return Promise.resolve(existing)
    if (options?.create) return Promise.resolve(this.addFile(name))
    return Promise.reject(new DOMException(`file not found: ${name}`, 'NotFoundError'))
  }
}

function sessionTree(): FakeDir {
  const root = new FakeDir('root')
  const s1 = root.addDir('sessions').addDir('s1')
  const f7 = s1.addDir('7')
  f7.addFile('photo.jpg').writable.chunks.push(new TextEncoder().encode('jpeg-bytes'))
  return root
}

describe('opfsMergedFile — 打开已拼接文件为磁盘背书 File', () => {
  it('按 sessions/<sessionId>/<fileId>/<name> 导航并返回 File', async () => {
    const root = sessionTree()
    const file = await opfsMergedFile('s1', 7, 'photo.jpg', () => Promise.resolve(root))
    expect(file.name).toBe('photo.jpg')
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe('jpeg-bytes')
  })

  it('嵌套目录名（photos/a.jpg）正确落在末段', async () => {
    const root = sessionTree()
    const photos = root.addDir('sessions').addDir('s1').addDir('7').addDir('photos')
    photos.addFile('a.jpg').writable.chunks.push(new TextEncoder().encode('x'))
    const file = await opfsMergedFile('s1', 7, 'photos/a.jpg', () => Promise.resolve(root))
    expect(file.name).toBe('a.jpg')
  })

  it('路径缺失（目录/文件不存在）→ 抛错', async () => {
    const root = new FakeDir('root')
    await expect(opfsMergedFile('s1', 7, 'photo.jpg', () => Promise.resolve(root))).rejects.toThrow(
      /not found/,
    )
  })
})

describe('withOpfsTempFile — OPFS 临时文件流式写', () => {
  it('写入 chunks → 关闭 → 返回内容一致的 File', async () => {
    const root = new FakeDir('root')
    const { file } = await withOpfsTempFile('全部文件.zip', async (writable) => {
      await writable.write(new Uint8Array([1, 2]))
      await writable.write(new Uint8Array([3, 4, 5]))
      return 'ok'
    }, () => Promise.resolve(root))
    expect(file.name).toBe('全部文件.zip')
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4, 5])
  })

  it('write 抛错 → 关闭 writable 并向上传播', async () => {
    const root = new FakeDir('root')
    await expect(
      withOpfsTempFile('x.zip', async () => {
        throw new Error('boom')
      }, () => Promise.resolve(root)),
    ).rejects.toThrow('boom')
  })
})

describe('writableChunkSink — 阈值批写 + final flush', () => {
  it('低于阈值不写；达到阈值批量写；final 强刷剩余', async () => {
    const writable = new FakeWritable()
    const sink = writableChunkSink(writable as unknown as FileSystemWritableFileStream, 2 * 1024 * 1024)
    const c1 = new Uint8Array(1024 * 1024).fill(1)
    const c2 = new Uint8Array(1024 * 1024).fill(2)
    const c3 = new Uint8Array(1024 * 1024).fill(3)

    await sink(c1, false) // 1MB < 2MB：不写
    expect(writable.chunks.length).toBe(0)
    await sink(c2, false) // 累计 2MB ≥ 阈值：批量写 c1+c2
    expect(writable.chunks.length).toBe(2)
    await sink(c3, false) // 1MB：不写
    expect(writable.chunks.length).toBe(2)
    await sink(new Uint8Array(0), true) // final：强刷 c3
    expect(writable.chunks.length).toBe(3)
    expect([...writable.chunks[0]]).toEqual([...c1])
    expect([...writable.chunks[2]]).toEqual([...c3])
  })

  it('返回的 promise 在批次写完后 resolve（背压语义）', async () => {
    const writable = new FakeWritable()
    const sink = writableChunkSink(writable as unknown as FileSystemWritableFileStream, 1024)
    const p = sink(new Uint8Array(2048).fill(9), false) // 超过阈值 → flush
    await p
    expect(writable.chunks.length).toBe(1)
  })
})
