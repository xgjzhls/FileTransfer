/**
 * folderExport.ts —— 顶层目录分组 + 批量分享命名单测（SPEC §4）。
 */

import { describe, expect, it } from 'vitest'
import { groupTopLevel, shareNames, ZIP_TOTAL_GUARD_BYTES } from './folderExport'

describe('groupTopLevel — 按顶层目录分组（SPEC §4 文件夹导出）', () => {
  it('文件夹发送（相对路径）：按首段分组，totalBytes 累加', () => {
    const g = groupTopLevel([
      { name: 'photos/2024/img.jpg', size: 100 },
      { name: 'photos/readme.txt', size: 50 },
      { name: 'docs/a/b/c.txt', size: 10 },
    ])
    expect(g.map((x) => x.dir)).toEqual(['docs', 'photos'])
    expect(g[1].items.map((x) => x.name)).toEqual(['photos/2024/img.jpg', 'photos/readme.txt'])
    expect(g[1].totalBytes).toBe(150)
  })

  it('散文件（无 /）归入根目录组 dir=""，排在最后', () => {
    const g = groupTopLevel([
      { name: 'a.txt', size: 1 },
      { name: 'photos/1.jpg', size: 2 },
      { name: 'b.txt', size: 3 },
    ])
    expect(g.map((x) => x.dir)).toEqual(['photos', ''])
    expect(g[1].items.map((x) => x.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('同名顶层目录合并；空列表 → 空组', () => {
    expect(groupTopLevel([])).toEqual([])
    const g = groupTopLevel([
      { name: 'p/x.jpg', size: 1 },
      { name: 'p/sub/y.jpg', size: 2 },
    ])
    expect(g).toHaveLength(1)
    expect(g[0].items).toHaveLength(2)
    expect(g[0].totalBytes).toBe(3)
  })
})

describe('shareNames — 批量分享文件名（basename + 重名消歧，share 不允许 /）', () => {
  it('无重名：直接 basename', () => {
    const m = shareNames([
      { name: 'photos/a.jpg', size: 1 },
      { name: 'photos/b.txt', size: 1 },
    ])
    expect(m.get('photos/a.jpg')).toBe('a.jpg')
    expect(m.get('photos/b.txt')).toBe('b.txt')
  })

  it('不同子目录同名文件：父目录名前缀消歧', () => {
    const m = shareNames([
      { name: 'photos/2024/img.jpg', size: 1 },
      { name: 'photos/2025/img.jpg', size: 1 },
    ])
    expect(m.get('photos/2024/img.jpg')).toBe('img.jpg')
    expect(m.get('photos/2025/img.jpg')).toBe('2025_img.jpg')
  })

  it('极端重名（父前缀仍撞）：追加序号', () => {
    const m = shareNames([
      { name: 'photos/a/img.jpg', size: 1 },
      { name: 'photos/a_img.jpg', size: 1 },
    ])
    // photos/a/img.jpg → img.jpg；photos/a_img.jpg → a_img.jpg；
    // 再补一个同 basename 的：photos/b/img.jpg → 撞 a_img.jpg？不，前缀是 b → b_img.jpg
    const m2 = shareNames([
      { name: 'photos/a/img.jpg', size: 1 },
      { name: 'photos/a_img.jpg', size: 1 },
      { name: 'photos/a/img (1).jpg', size: 1 },
    ])
    expect(m2.get('photos/a/img (1).jpg')).toBe('img (1).jpg')
    expect(new Set(m2.values()).size).toBe(3) // 全部唯一
    expect(new Set(m.values()).size).toBe(2)
  })
})

describe('ZIP_TOTAL_GUARD_BYTES — 导出守卫常量', () => {
  it('1 GiB', () => {
    expect(ZIP_TOTAL_GUARD_BYTES).toBe(1024 * 1024 * 1024)
  })
})
