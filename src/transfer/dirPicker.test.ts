/**
 * dirPicker —— 桌面 Chrome File System Access 选文件夹（SPEC §6.3）。
 *
 * walkDirectory：递归遍历 FileSystemDirectoryHandle → 扁平文件列表，
 * name 为相对路径（/ 分隔，保留子目录结构）；isSafeRelPath 防御
 * 路径穿越（../、绝对路径、反斜杠等）；basename 供导出 UI 用。
 */

import { describe, expect, it } from 'vitest'
import { walkDirectory, isSafeRelPath, basename } from './dirPicker'
import type { PickedDirFile, WalkResult } from './dirPicker'

/** 最小 FileSystemDirectoryHandle mock（只实现本模块用到的接口） */
interface FakeDir {
  kind: 'directory'
  entries(): AsyncIterable<[string, FakeDir | FakeFile]>
}
interface FakeFile {
  kind: 'file'
  getFile(): Promise<File>
}
type FakeHandle = FakeDir | FakeFile

function dir(children: Record<string, FakeHandle>): FakeDir {
  const entries: [string, FakeHandle][] = Object.entries(children)
  return {
    kind: 'directory',
    entries: async function* () {
      // 按名字排序遍历（与真实浏览器行为一致；walkDirectory 内部还会再排一次）
      for (const [name, handle] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
        yield [name, handle]
      }
    },
  }
}

function file(name: string, content = 'x'): FakeFile {
  return { kind: 'file', getFile: async () => new File([content], name) }
}

function namesOf(list: PickedDirFile[]): string[] {
  return list.map((f) => f.name)
}

/** 测试 helper：内存 mock 目录 → walkDirectory（cast 到浏览器类型） */
function walk(root: FakeDir): Promise<WalkResult> {
  return walkDirectory(root as unknown as FileSystemDirectoryHandle)
}

describe('walkDirectory — 递归遍历 + 相对路径（SPEC §6.3）', () => {
  it('空目录 → 空文件列表', async () => {
    expect(await walk(dir({}))).toEqual({ files: [], skipped: [] })
  })

  it('根目录文件：name = 纯文件名', async () => {
    const list = await walk(dir({ 'a.txt': file('a.txt'), 'b.bin': file('b.bin') }))
    expect(namesOf(list.files)).toEqual(['a.txt', 'b.bin'])
    expect(list.skipped).toEqual([])
  })

  it('嵌套子目录：name = 相对路径（/ 分隔），递归深度不限', async () => {
    const root = dir({
      'docs': dir({
        '2024': dir({ 'img.jpg': file('img.jpg') }),
        'readme.md': file('readme.md'),
      }),
      'top.txt': file('top.txt'),
    })
    const list = await walk(root)
    expect(namesOf(list.files)).toEqual(['docs/2024/img.jpg', 'docs/readme.md', 'top.txt'])
  })

  it('DFS 先序 + 每层按名排序：输出确定性，不依赖遍历顺序', async () => {
    // entries 以乱序构造；walkDirectory 必须显式排序保证确定性。
    // 注意不是全局字典序：父目录条目（a/）先于同级文件（a.txt）展开
    const root = dir({
      'z.txt': file('z.txt'),
      'a': dir({ 'n.txt': file('n.txt') }),
      'a.txt': file('a.txt'),
      'b': dir({ '0.txt': file('0.txt') }),
    })
    const list = await walk(root)
    expect(namesOf(list.files)).toEqual(['a/n.txt', 'a.txt', 'b/0.txt', 'z.txt'])
  })

  it('保留 baseName（真实文件名，导出用）', async () => {
    const list = await walk(dir({ 'p': dir({ 'IMG_0001.JPG': file('IMG_0001.JPG') }) }))
    expect(list.files[0].baseName).toBe('IMG_0001.JPG')
    expect(list.files[0].file.name).toBe('IMG_0001.JPG')
    expect(list.files[0].name).toBe('p/IMG_0001.JPG')
  })

  it('多级混合：文件与目录交错', async () => {
    const root = dir({
      'videos': dir({
        'clip1.mp4': file('clip1.mp4'),
        'clips': dir({ 'clip2.mp4': file('clip2.mp4') }),
      }),
      'notes.txt': file('notes.txt'),
    })
    expect(namesOf((await walk(root)).files)).toEqual([
      'notes.txt',
      'videos/clip1.mp4',
      'videos/clips/clip2.mp4',
    ])
  })

  it('路径不安全的条目（含 \\ 的合法 Unix 名等）记入 skipped，不进队列', async () => {
    const root = dir({
      'ok.txt': file('ok.txt'),
      'a\\b.txt': file('a\\b.txt'), // macOS/Linux 合法文件名（含反斜杠）
      'p': dir({
        'img.jpg': file('img.jpg'),
        '..\\evil': file('..\\evil'), // 子目录内同样被拒并累计
        'sub': dir({ 'n.txt': file('n.txt') }),
      }),
    })
    const r = await walk(root)
    expect(namesOf(r.files)).toEqual(['ok.txt', 'p/img.jpg', 'p/sub/n.txt'])
    expect(r.skipped).toEqual(['a\\b.txt', 'p/..\\evil'])
  })
})

describe('isSafeRelPath — 路径安全（防 ../ 穿越 / 绝对路径）', () => {
  it('合法相对路径通过', () => {
    expect(isSafeRelPath('a.txt')).toBe(true)
    expect(isSafeRelPath('docs/2024/img.jpg')).toBe(true)
    expect(isSafeRelPath('a/b/c.txt')).toBe(true)
  })

  it('拒绝父目录穿越（..）', () => {
    expect(isSafeRelPath('..')).toBe(false)
    expect(isSafeRelPath('../evil')).toBe(false)
    expect(isSafeRelPath('a/../evil')).toBe(false)
    expect(isSafeRelPath('a/..')).toBe(false)
    expect(isSafeRelPath('...')).toBe(true) // 非精确「..」段合法
    expect(isSafeRelPath('a/.../b')).toBe(true)
  })

  it('拒绝绝对路径与反斜杠', () => {
    expect(isSafeRelPath('/abs/path')).toBe(false)
    expect(isSafeRelPath('a\\b')).toBe(false)
    expect(isSafeRelPath('a/..\\b')).toBe(false)
    expect(isSafeRelPath('C:\\evil')).toBe(false)
  })

  it('拒绝空路径、空段与 . 段', () => {
    expect(isSafeRelPath('')).toBe(false)
    expect(isSafeRelPath('a//b')).toBe(false)
    expect(isSafeRelPath('./a')).toBe(false)
    expect(isSafeRelPath('a/./b')).toBe(false)
    expect(isSafeRelPath('/')).toBe(false)
  })

  it('拒绝控制字符与非法尾斜杠', () => {
    expect(isSafeRelPath('a\0b.txt')).toBe(false)
    expect(isSafeRelPath('a.txt/')).toBe(false)
  })
})

describe('basename — 导出文件名取末段', () => {
  it('含路径：取最后一段', () => {
    expect(basename('photos/2024/img.jpg')).toBe('img.jpg')
    expect(basename('a/b/c.txt')).toBe('c.txt')
  })
  it('纯文件名原样返回', () => {
    expect(basename('img.jpg')).toBe('img.jpg')
    expect(basename('')).toBe('')
  })
})
