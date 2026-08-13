import { describe, expect, it } from 'vitest'
import { PHOTO_GATE_BYTES, classifyExport } from './export'

describe('classifyExport — 照片门控（SPEC §4）', () => {
  it('图片 <300MiB → photo', () => {
    expect(classifyExport('photo.jpg', 1024 * 1024)).toBe('photo')
  })

  it('视频 <300MiB → photo', () => {
    expect(classifyExport('clip.mp4', 200 * 1024 * 1024)).toBe('photo')
  })

  it('大视频（≥300MiB）→ file（spike 实测 Web Share 大视频崩溃）', () => {
    expect(classifyExport('big.mp4', 600 * 1024 * 1024)).toBe('file')
  })

  it('恰好 300MiB → file（严格小于才进照片）', () => {
    expect(classifyExport('edge.mov', PHOTO_GATE_BYTES)).toBe('file')
  })

  it('299MiB 视频 → photo', () => {
    expect(classifyExport('edge.mov', PHOTO_GATE_BYTES - 1)).toBe('photo')
  })

  it('非媒体文件 → file', () => {
    expect(classifyExport('doc.pdf', 1024)).toBe('file')
    expect(classifyExport('archive.zip', 50 * 1024 * 1024)).toBe('file')
  })

  it('无扩展名 → file', () => {
    expect(classifyExport('README', 1024)).toBe('file')
  })

  it('大写扩展名归一化', () => {
    expect(classifyExport('IMG_001.JPG', 1024)).toBe('photo')
  })
})
