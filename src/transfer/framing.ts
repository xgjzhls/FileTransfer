/**
 * 通道内消息 framing（SPEC §3.2）。
 *
 * 首字节 type：
 *   0x00 JSON 控制消息（UTF-8）
 *   0x01 chunk 数据：[fileId u32][partIndex u32][chunkIndex u32][payload ≤1MiB]
 * 大小端按网络序（大端，DataView 默认）。
 */

export const CONTROL = 0x00
export const CHUNK = 0x01

const CHUNK_HEADER = 1 + 4 + 4 + 4

export function encodeChunk(
  fileId: number,
  partIndex: number,
  chunkIndex: number,
  payload: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(CHUNK_HEADER + payload.length)
  frame[0] = CHUNK
  const dv = new DataView(frame.buffer, frame.byteOffset)
  dv.setUint32(1, fileId)
  dv.setUint32(5, partIndex)
  dv.setUint32(9, chunkIndex)
  frame.set(payload, CHUNK_HEADER)
  return frame
}

export function parseChunk(
  data: Uint8Array,
): { fileId: number; partIndex: number; chunkIndex: number; payload: Uint8Array } | null {
  if (data.length < CHUNK_HEADER || data[0] !== CHUNK) return null
  const dv = new DataView(data.buffer, data.byteOffset)
  return {
    fileId: dv.getUint32(1),
    partIndex: dv.getUint32(5),
    chunkIndex: dv.getUint32(9),
    payload: data.subarray(CHUNK_HEADER),
  }
}

export function encodeControl(message: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = CONTROL
  frame.set(json, 1)
  return frame
}

export function parseControl(data: Uint8Array): unknown | null {
  if (data.length < 1 || data[0] !== CONTROL) return null
  try {
    return JSON.parse(new TextDecoder().decode(data.subarray(1))) as unknown
  } catch {
    return null
  }
}
