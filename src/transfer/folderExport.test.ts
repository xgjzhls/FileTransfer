/**
 * folderExport.ts —— 顶层目录分组 + 批量分享/去重命名单测（SPEC §4）。
 */

import { describe, expect, it } from 'vitest'
import { groupTopLevel, shareNames, uniqueZipPaths, ZIP_TOTAL_GUARD_BYTES, sumBytes, disambiguateRootVsDir } from './folderExport'
import type { FolderExportItem } from './folderExport'

const item = (name: string, size = 1): FolderExportItem => ({ name, size })

describe('groupTopLevel — 按顶层目录分组（SPEC §4 文件夹导出）', () => {
  it('文件夹发送（相对路径）：按首段分组，totalBytes 累加', () => {
    const g = groupTopLevel([
      item('photos/2024/img.jpg', 100),
      item('photos/readme.txt', 50),
      item('docs/a/b/c.txt', 10),
    ])
    expect(g.map((x) => x.dir)).toEqual(['docs', 'photos'])
    expect(g[1].items.map((x) => x.name)).toEqual(['photos/2024/img.jpg', 'photos/readme.txt'])
    expect(g[1].totalBytes).toBe(150)
  })

  it('散文件（无 /）归入根目录组 dir=""，排在最后', () => {
    const g = groupTopLevel([item('a.txt', 1), item('photos/1.jpg', 2), item('b.txt', 3)])
    expect(g.map((x) => x.dir)).toEqual(['photos', ''])
    expect(g[1].items.map((x) => x.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('同名顶层目录合并；空列表 → 空组', () => {
    expect(groupTopLevel([])).toEqual([])
    const g = groupTopLevel([item('p/x.jpg', 1), item('p/sub/y.jpg', 2)])
    expect(g).toHaveLength(1)
    expect(g[0].items).toHaveLength(2)
    expect(g[0].totalBytes).toBe(3)
  })
})

describe('shareNames — 批量分享文件名（basename + 重名消歧，share 不允许 /）', () => {
  it('无重名：直接 basename', () => {
    const a = item('photos/a.jpg')
    const b = item('photos/b.txt')
    const m = shareNames([a, b])
    expect(m.get(a)).toBe('a.jpg')
    expect(m.get(b)).toBe('b.txt')
  })

  it('不同子目录同名文件：父目录名前缀消歧', () => {
    const a = item('photos/2024/img.jpg')
    const b = item('photos/2025/img.jpg')
    const m = shareNames([a, b])
    expect(m.get(a)).toBe('img.jpg')
    expect(m.get(b)).toBe('2025_img.jpg')
  })

  it('同名文件（多选发送，同 name 条目共存）：各自唯一，不互相覆盖', () => {
    const a = item('IMG_0001.JPG')
    const b = item('IMG_0001.JPG')
    const m = shareNames([a, b])
    expect(m.get(a)).toBe('IMG_0001.JPG')
    expect(m.get(b)).toBe('IMG_0001.JPG (2)')
    expect(new Set(m.values()).size).toBe(2)
  })

  it('极端重名（父前缀仍撞）：追加序号', () => {
    const a = item('photos/a/img.jpg')
    const b = item('photos/a_img.jpg')
    const c = item('photos/a/img (1).jpg')
    const m = shareNames([a, b, c])
    expect(m.get(c)).toBe('img (1).jpg')
    expect(new Set(m.values()).size).toBe(3) // 全部唯一
  })
})

describe('uniqueZipPaths — zip/目录导出重名去重', () => {
  it('无重名：原样返回', () => {
    const a = item('photos/a.jpg')
    const b = item('photos/b.txt')
    const m = uniqueZipPaths([a, b])
    expect(m.get(a)).toBe('photos/a.jpg')
    expect(m.get(b)).toBe('photos/b.txt')
  })

  it('T20 跨组勾选：不同目录同名 + 根目录同名互不冲突（全路径去重）', () => {
    const root = item('a.jpg')
    const photos = item('photos/a.jpg')
    const docs = item('docs/a.jpg')
    const img1 = item('IMG_0001.JPG')
    const img2 = item('IMG_0001.JPG')
    const m = uniqueZipPaths([root, photos, docs, img1, img2])
    expect(m.get(root)).toBe('a.jpg')
    expect(m.get(photos)).toBe('photos/a.jpg')
    expect(m.get(docs)).toBe('docs/a.jpg')
    expect(m.get(img1)).toBe('IMG_0001.JPG')
    expect(m.get(img2)).toBe('IMG_0001.JPG (2)')
    expect(new Set(m.values()).size).toBe(5) // 全部唯一
  })

  it('同名文件（多选发送）：追加序号，结构不变，各条目独立', () => {
    const a = item('IMG_0001.JPG')
    const b = item('IMG_0001.JPG')
    const c = item('IMG_0001.JPG')
    const m = uniqueZipPaths([a, b, c])
    expect(m.get(a)).toBe('IMG_0001.JPG')
    expect(m.get(b)).toBe('IMG_0001.JPG (2)')
    expect(m.get(c)).toBe('IMG_0001.JPG (3)')
    expect(new Set(m.values()).size).toBe(3)
  })

  it('与同名文件本身重名（原名字段已是 x (2)）：继续追加', () => {
    const a = item('a.txt')
    const b = item('a.txt')
    const c = item('a.txt (2)')
    const m = uniqueZipPaths([a, b, c])
    expect(m.get(a)).toBe('a.txt')
    expect(m.get(b)).toBe('a.txt (2)')
    expect(m.get(c)).toBe('a.txt (2) (2)')
    expect(new Set(m.values()).size).toBe(3)
  })
})

describe('ZIP_TOTAL_GUARD_BYTES — 导出守卫常量', () => {
  it('1 GiB', () => {
    expect(ZIP_TOTAL_GUARD_BYTES).toBe(1024 * 1024 * 1024)
  })
})

describe('sumBytes — 勾选条目总大小（T20 批量导出守卫）', () => {
  it('累加 size', () => {
    expect(sumBytes([item('a.txt', 100), item('b.txt', 50), item('c.txt', 0)])).toBe(150)
  })

  it('空列表 → 0', () => {
    expect(sumBytes([])).toBe(0)
  })
})

describe('disambiguateRootVsDir — 根散文件 vs 目录名冲突消歧（T20 跨组 FSA/zip 导出）', () => {
  it('根散文件名撞目录首段：目录优先，散文件追加序号', () => {
    const rootFile = item('photos')
    const inDir = item('photos/a.jpg')
    const m = disambiguateRootVsDir([rootFile, inDir])
    expect(m.get(rootFile)).toBe('photos (2)')
    expect(m.get(inDir)).toBe('photos/a.jpg')
  })

  it('同名根散文件照常去重（多选同名）', () => {
    const a = item('IMG_0001.JPG')
    const b = item('IMG_0001.JPG')
    const m = disambiguateRootVsDir([a, b])
    expect(m.get(a)).toBe('IMG_0001.JPG')
    expect(m.get(b)).toBe('IMG_0001.JPG (2)')
  })

  it('跨组混合：目录文件不动、根散文件不撞目录时原样、撞目录 + 重名共存仍全唯一', () => {
    const rootA = item('photos')
    const rootB = item('photos')
    const a = item('a.jpg')
    const photos = item('photos/a.jpg')
    const docs = item('docs/a.jpg')
    const m = disambiguateRootVsDir([rootA, rootB, a, photos, docs])
    expect(m.get(rootA)).toBe('photos (2)')
    expect(m.get(rootB)).toBe('photos (3)')
    expect(m.get(a)).toBe('a.jpg')
    expect(m.get(photos)).toBe('photos/a.jpg')
    expect(m.get(docs)).toBe('docs/a.jpg')
    expect(new Set(m.values()).size).toBe(5) // 全部唯一
  })
})
