/**
 * nativeExport 分块拷贝泵的单测（T02/T03 seam）。
 * 用 fake bridge 校验：分块边界 / isFirst / isLast / base64 内容 / mkdir / 进度 / 取消语义。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHUNK_BYTES,
  NativeExportAbortedError,
  bytesToBase64,
  caseInsensitiveUnique,
  copyFileToNative,
  copyFilesToNative,
  writeFileToTemp,
  type NativeExportBridge,
} from './nativeExport'

/** 构造内存 File（node 环境 Blob/File 可用） */
function fileOf(bytes: Uint8Array<ArrayBuffer>, name = 'a.bin'): File {
  return new File([bytes], name)
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff
  return out
}

/** fake bridge：记录调用 + 按 relPath 重拼字节 */
class FakeBridge implements NativeExportBridge {
  mkdirs: string[] = []
  writes: Array<{ file: string; data: string; isFirst: boolean; isLast: boolean }> = []
  aborts = 0
  abortedAfterChunk: number | null = null // 第 N 块 writeChunk resolve 后触发取消
  failWriteChunk = false
  okFalse = false // 返回 ok:false（桥假成功场景）
  private ctrl: AbortController | null

  constructor(ctrl: AbortController | null = null) {
    this.ctrl = ctrl
  }

  async mkdir({ relDir }: { relDir: string }) {
    this.mkdirs.push(relDir)
    return { ok: true }
  }
  async writeChunk(o: { file: string; data: string; isFirst: boolean; isLast: boolean }) {
    if (this.failWriteChunk) throw new Error('native write failed')
    if (this.okFalse) return { ok: false, bytes: 0 }
    this.writes.push(o)
    const bytes = o.data === '' ? new Uint8Array(0) : new Uint8Array(Buffer.from(o.data, 'base64'))
    this.contentOf(o.file).push(bytes)
    if (this.abortedAfterChunk !== null && this.writes.length >= this.abortedAfterChunk) {
      this.ctrl?.abort()
    }
    const size = o.isLast
      ? this.contentOf(o.file).reduce((s, b) => s + b.byteLength, 0)
      : undefined
    return { ok: true, bytes: bytes.byteLength, size }
  }
  async writeTemp(o: { name: string; data: string; isFirst: boolean; isLast: boolean }) {
    if (this.okFalse) return { ok: false, bytes: 0 }
    this.writes.push({ file: o.name, data: o.data, isFirst: o.isFirst, isLast: o.isLast })
    const bytes = o.data === '' ? new Uint8Array(0) : new Uint8Array(Buffer.from(o.data, 'base64'))
    this.contentOf(o.name).push(bytes)
    return {
      ok: true,
      bytes: bytes.byteLength,
      size: o.isLast ? bytes.byteLength : undefined,
      url: o.isLast ? 'file:///tmp/LocalTransferShare/' + o.name : undefined,
    }
  }
  async abort() {
    this.aborts++
    return { ok: true, cleaned: true }
  }
  private contentOf(file: string): Uint8Array[] {
    const key = file
    if (!this.chunksByFile.has(key)) this.chunksByFile.set(key, [])
    return this.chunksByFile.get(key)!
  }
  private chunksByFile = new Map<string, Uint8Array[]>()

  joined(file: string): Uint8Array {
    return Buffer.concat(this.contentOf(file).map((b) => Buffer.from(b)))
  }
}

describe('bytesToBase64', () => {
  it('与 Buffer 基准一致（含 32KB 边界与 4MiB 大块）', () => {
    for (const n of [0, 1, 3, 0x8000, 0x8001, 0x8000 - 1, NATIVE_CHUNK_BYTES]) {
      const bytes = randomBytes(n)
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    }
  })
})

describe('copyFileToNative', () => {
  it('按块分块写：isFirst/isLast 正确、base64 内容重拼一致、mkdir 建父目录', async () => {
    const bridge = new FakeBridge()
    const data = randomBytes(10 * 1024 * 1024 + 123) // 4+4+2 MiB + 123 B
    const progress: number[] = []
    const res = await copyFileToNative({
      bridge,
      file: fileOf(data, 'photos/2024/img.jpg'),
      relPath: 'photos/2024/img.jpg',
      onProgress: (w) => progress.push(w),
    })
    expect(res.size).toBe(data.length)
    // 分块：3 块（4MiB, 4MiB, 余量）
    expect(bridge.writes.length).toBe(3)
    expect(bridge.writes[0].isFirst).toBe(true)
    expect(bridge.writes[0].isLast).toBe(false)
    expect(bridge.writes[1].isFirst).toBe(false)
    expect(bridge.writes[1].isLast).toBe(false)
    expect(bridge.writes[2].isFirst).toBe(false)
    expect(bridge.writes[2].isLast).toBe(true)
    // 每块 base64 解码后大小 = 块大小（最后一块为余量）
    expect(Buffer.from(bridge.writes[0].data, 'base64').byteLength).toBe(NATIVE_CHUNK_BYTES)
    expect(Buffer.from(bridge.writes[2].data, 'base64').byteLength).toBe(data.length - 2 * NATIVE_CHUNK_BYTES)
    // 重拼 == 原文
    expect(Buffer.compare(Buffer.from(bridge.joined('photos/2024/img.jpg')), Buffer.from(data))).toBe(0)
    // mkdir 建父目录一次
    expect(bridge.mkdirs).toEqual(['photos/2024'])
    // 进度单调到 total
    expect(progress).toEqual([NATIVE_CHUNK_BYTES, 2 * NATIVE_CHUNK_BYTES, data.length])
  })

  it('顶层文件（无 /）不调用 mkdir', async () => {
    const bridge = new FakeBridge()
    await copyFileToNative({ bridge, file: fileOf(randomBytes(100), 'a.bin'), relPath: 'a.bin' })
    expect(bridge.mkdirs).toEqual([])
  })

  it('空文件：单次空块建文件', async () => {
    const bridge = new FakeBridge()
    const res = await copyFileToNative({ bridge, file: fileOf(new Uint8Array(0)), relPath: 'empty.txt' })
    expect(res.size).toBe(0)
    expect(bridge.writes).toEqual([{ file: 'empty.txt', data: '', isFirst: true, isLast: true }])
  })

  it('取消信号在首块前触发：抛 NativeExportAbortedError + 桥 abort，无写入', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const bridge = new FakeBridge(ctrl)
    await expect(
      copyFileToNative({ bridge, file: fileOf(randomBytes(1000)), relPath: 'a.bin', signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(NativeExportAbortedError)
    expect(bridge.aborts).toBe(1)
    expect(bridge.writes.length).toBe(0)
  })

  it('取消信号在写中触发：停当前文件，半成品由桥清理（abort 调用）', async () => {
    const ctrl = new AbortController()
    const bridge = new FakeBridge(ctrl)
    bridge.abortedAfterChunk = 1 // 第一块写完即取消
    await expect(
      copyFileToNative({ bridge, file: fileOf(randomBytes(3 * NATIVE_CHUNK_BYTES)), relPath: 'a.bin', signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(NativeExportAbortedError)
    expect(bridge.writes.length).toBe(1) // 只写了第一块
    expect(bridge.aborts).toBe(1)
  })
})

describe('copyFilesToNative', () => {
  it('逐文件拷贝：回调按序触发，返回已拷数量', async () => {
    const bridge = new FakeBridge()
    const entries = [
      { file: fileOf(randomBytes(10), 'a.txt'), relPath: 'a.txt' },
      { file: fileOf(randomBytes(20), 'b.txt'), relPath: 'd/b.txt' },
    ]
    const starts: string[] = []
    const dones: number[] = []
    const res = await copyFilesToNative({
      bridge,
      entries,
      onFileStart: (_i, name) => starts.push(name),
      onFileDone: (i) => dones.push(i),
    })
    expect(res).toEqual({ copied: 2, cancelled: false })
    expect(starts).toEqual(['a.txt', 'd/b.txt'])
    expect(dones).toEqual([0, 1])
    expect(bridge.mkdirs).toEqual(['d'])
  })

  it('文件 2 开始时取消：已拷 1 个保留，cancelled=true，文件 3 不启动', async () => {
    const ctrl = new AbortController()
    const bridge = new FakeBridge(ctrl)
    const entries = [
      { file: fileOf(randomBytes(10), 'a.txt'), relPath: 'a.txt' },
      { file: fileOf(randomBytes(10), 'b.txt'), relPath: 'b.txt' },
      { file: fileOf(randomBytes(10), 'c.txt'), relPath: 'c.txt' },
    ]
    const starts: string[] = []
    const res = await copyFilesToNative({
      bridge,
      entries,
      signal: ctrl.signal,
      onFileStart: (_i, name) => {
        starts.push(name)
        if (name === 'b.txt') ctrl.abort()
      },
    })
    expect(res).toEqual({ copied: 1, cancelled: true })
    expect(starts).toEqual(['a.txt', 'b.txt'])
    expect(bridge.writes.filter((w) => w.isLast && w.file === 'a.txt').length).toBe(1)
    expect(bridge.aborts).toBe(1)
  })

  it('写错误向上抛出（不吞错）', async () => {
    const bridge = new FakeBridge()
    bridge.failWriteChunk = true
    await expect(
      copyFilesToNative({ bridge, entries: [{ file: fileOf(randomBytes(10)), relPath: 'a.bin' }] }),
    ).rejects.toThrow('native write failed')
  })
})

describe('caseInsensitiveUnique（APFS 大小写不敏感消歧）', () => {
  it('字节级去重后仍冲突的同名不同大小写条目追加序号，不覆盖', () => {
    const base = new Map<string, string>([
      ['a', 'IMG_0001.JPG'],
      ['b', 'img_0001.jpg'],
      ['c', 'IMG_0001.JPG'], // 第三个（uniqueZipPaths 已处理过的输入场景）
    ])
    const out = caseInsensitiveUnique(base)
    const values = [...out.values()]
    expect(values[0]).toBe('IMG_0001.JPG')
    expect(values[1]).toBe('img_0001 (2).jpg')
    expect(values[2]).toBe('IMG_0001 (3).JPG')
    // 大小写不敏感维度全部唯一
    expect(new Set(values.map((v) => v.toLowerCase())).size).toBe(3)
  })

  it('目录相对路径含多段扩展名正确保留后缀（最后一点为扩展名，与 OS 一致）', () => {
    const base = new Map<string, string>([
      ['a', 'photos/Archive.tar.gz'],
      ['b', 'PHOTOS/archive.tar.gz'],
    ])
    const out = caseInsensitiveUnique(base)
    const values = [...out.values()]
    expect(values[1]).toBe('PHOTOS/archive.tar (2).gz')
  })

  it('无冲突时原样保留', () => {
    const base = new Map<string, string>([
      ['a', 'a.jpg'],
      ['b', 'b.jpg'],
    ])
    expect([...caseInsensitiveUnique(base).values()]).toEqual(['a.jpg', 'b.jpg'])
  })
})

describe('桥 ok=false（原生侧假成功）', () => {
  it('copyFileToNative 抛错并调用 abort 清理半成品', async () => {
    const bridge = new FakeBridge()
    bridge.okFalse = true
    await expect(
      copyFileToNative({ bridge, file: fileOf(randomBytes(100)), relPath: 'a.bin' }),
    ).rejects.toThrow('ok=false')
    expect(bridge.aborts).toBe(1)
  })

  it('writeFileToTemp 抛错（未确认 ok）', async () => {
    const bridge = new FakeBridge()
    bridge.okFalse = true
    await expect(writeFileToTemp(bridge, fileOf(randomBytes(100)), 'a.bin')).rejects.toThrow()
  })
})

describe('writeFileToTemp', () => {
  it('分块写临时文件并返回 file:// URL', async () => {
    const bridge = new FakeBridge()
    const data = randomBytes(NATIVE_CHUNK_BYTES + 5)
    const url = await writeFileToTemp(bridge, fileOf(data, 'big.bin'), 'big.bin')
    expect(url).toBe('file:///tmp/LocalTransferShare/big.bin')
    expect(bridge.writes.map((w) => w.file)).toEqual(['big.bin', 'big.bin'])
    expect(bridge.writes[0].isFirst).toBe(true)
    expect(bridge.writes[1].isLast).toBe(true)
    expect(Buffer.compare(Buffer.from(bridge.joined('big.bin')), Buffer.from(data))).toBe(0)
  })

  it('空文件返回 URL；isLast 未返回 URL 时抛错', async () => {
    const bridge = new FakeBridge()
    const url = await writeFileToTemp(bridge, fileOf(new Uint8Array(0)), 'empty.bin')
    expect(url).toBe('file:///tmp/LocalTransferShare/empty.bin')
    vi.spyOn(bridge, 'writeTemp').mockResolvedValue({ ok: true, bytes: 0, size: 0, url: undefined })
    await expect(writeFileToTemp(bridge, fileOf(new Uint8Array(0)), 'x.bin')).rejects.toThrow('writeTemp 未确认')
  })
})
