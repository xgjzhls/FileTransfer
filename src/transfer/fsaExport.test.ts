/**
 * fsaExport —— 桌面 FSA 流式写树单测（T23）。
 * fake 目录/文件句柄：逐段建目录 + 分块写文件内容。
 */

import { describe, expect, it } from 'vitest'
import { writeFileStreamTree } from './fsaExport'

class FakeWritable {
  chunks: Uint8Array[] = []
  closed = false
  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk)
  }
  async close(): Promise<void> {
    this.closed = true
  }
  concat(): Uint8Array {
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

class FakeFileHandle {
  readonly writable = new FakeWritable()
  readonly name: string
  constructor(name: string) {
    this.name = name
  }
  async createWritable(): Promise<FakeWritable> {
    return this.writable
  }
}

class FakeDir {
  readonly dirs = new Map<string, FakeDir>()
  readonly files = new Map<string, FakeFileHandle>()
  readonly name: string
  constructor(name: string) {
    this.name = name
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    let d = this.dirs.get(name)
    if (!d && options?.create) {
      d = new FakeDir(name)
      this.dirs.set(name, d)
    }
    if (!d) throw new Error(`dir not found: ${name}`)
    return d
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    let f = this.files.get(name)
    if (!f && options?.create) {
      f = new FakeFileHandle(name)
      this.files.set(name, f)
    }
    if (!f) throw new Error(`file not found: ${name}`)
    return f
  }
}

function chunkedFile(content: Uint8Array): File {
  return new File([content.buffer as ArrayBuffer], 'src.bin')
}

describe('writeFileStreamTree — 流式写文件树（T23）', () => {
  it('嵌套路径：逐段建目录，文件落在末段，内容分块完整', async () => {
    const root = new FakeDir('root')
    const content = new Uint8Array([1, 2, 3, 4, 5])
    await writeFileStreamTree(root as unknown as FileSystemDirectoryHandle, 'photos/2024/img.jpg', chunkedFile(content))

    // photos/2024/img.jpg 写入
    const photos = root.dirs.get('photos')
    expect(photos).toBeDefined()
    const y2024 = photos!.dirs.get('2024')
    expect(y2024).toBeDefined()
    const file = y2024!.files.get('img.jpg')
    expect(file).toBeDefined()
    expect([...file!.writable.concat()]).toEqual([...content])
    expect(file!.writable.closed).toBe(true)
  })

  it('根目录散文件（无 /）：直接落在目标根', async () => {
    const root = new FakeDir('root')
    await writeFileStreamTree(root as unknown as FileSystemDirectoryHandle, 'a.txt', chunkedFile(new Uint8Array([9])))
    expect(root.files.get('a.txt')).toBeDefined()
    expect([...root.files.get('a.txt')!.writable.concat()]).toEqual([9])
  })

  it('分块读取：File.stream() 逐块写（大文件零驻留）', async () => {
    const root = new FakeDir('root')
    // 1.5MB 文件（跨多个流块）
    const content = new Uint8Array(1536 * 1024)
    for (let i = 0; i < content.length; i += 3) content[i] = 0xab
    await writeFileStreamTree(root as unknown as FileSystemDirectoryHandle, 'big.bin', chunkedFile(content))
    const written = root.files.get('big.bin')!.writable.concat()
    expect(written.length).toBe(content.length)
    expect([...written]).toEqual([...content])
  })
})
