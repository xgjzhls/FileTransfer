import { describe, expect, it } from 'vitest'
import { CHUNK, CONTROL, encodeChunk, encodeControl, parseChunk, parseControl } from './framing'

describe('chunk framing（SPEC §3.2）', () => {
  it('头部布局：[0x01][fileId u32][partIndex u32][chunkIndex u32][payload]', () => {
    const payload = new Uint8Array([1, 2, 3])
    const frame = encodeChunk(0, 2, 5, payload)
    expect(frame.length).toBe(1 + 4 + 4 + 4 + 3)
    expect(frame[0]).toBe(CHUNK)
    const dv = new DataView(frame.buffer, frame.byteOffset)
    expect(dv.getUint32(1)).toBe(0)
    expect(dv.getUint32(5)).toBe(2)
    expect(dv.getUint32(9)).toBe(5)
  })

  it('roundtrip：encode → parse 还原全部字段与 payload', () => {
    const payload = new Uint8Array(1024).map((_, i) => i % 256)
    const parsed = parseChunk(encodeChunk(7, 3, 99, payload))
    expect(parsed).not.toBeNull()
    expect(parsed!.fileId).toBe(7)
    expect(parsed!.partIndex).toBe(3)
    expect(parsed!.chunkIndex).toBe(99)
    expect(parsed!.payload).toEqual(payload)
  })

  it('u32 上限值 roundtrip', () => {
    const parsed = parseChunk(encodeChunk(4294967295, 4294967295, 4294967295, new Uint8Array(0)))
    expect(parsed).toEqual({ fileId: 4294967295, partIndex: 4294967295, chunkIndex: 4294967295, payload: new Uint8Array(0) })
  })

  it('空 payload roundtrip', () => {
    const parsed = parseChunk(encodeChunk(0, 0, 0, new Uint8Array(0)))
    expect(parsed?.payload.length).toBe(0)
  })

  it('parse 数据不足（<13 字节）→ null', () => {
    expect(parseChunk(new Uint8Array(12))).toBeNull()
    expect(parseChunk(new Uint8Array(0))).toBeNull()
  })

  it('parse 非 chunk 类型（0x00 控制）→ null', () => {
    expect(parseChunk(new Uint8Array([CONTROL, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })
})

describe('control framing（SPEC §3.2）', () => {
  it('roundtrip：JSON 控制消息', () => {
    const msg = { type: 'part_done', fileId: 0, partIndex: 2, sha256: 'abc' }
    const frame = encodeControl(msg)
    expect(frame[0]).toBe(CONTROL)
    expect(parseControl(frame)).toEqual(msg)
  })

  it('多字节 UTF-8（中文文件名）roundtrip', () => {
    const msg = { type: 'meta', files: [{ name: '视频.mov' }] }
    expect(parseControl(encodeControl(msg))).toEqual(msg)
  })

  it('非法 control 帧（首字节非 0x00）→ null', () => {
    expect(parseControl(new Uint8Array([CHUNK, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })

  it('control 数据非 JSON → null', () => {
    const frame = new Uint8Array([CONTROL, ...new TextEncoder().encode('not json{{')])
    expect(parseControl(frame)).toBeNull()
  })
})
