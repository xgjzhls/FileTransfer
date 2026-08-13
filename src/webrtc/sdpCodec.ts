/**
 * SDP 压缩编码（SPEC §5.1/§5.3）。
 *
 * 单协议双载体：WS 与 QR 共用同一个 signal.payload 结构，
 * sdp 字段统一为 gzip + base64url（候选密集的 offer 可压 90%+，
 * 单码 QR 装得下）。浏览器用 CompressionStream / btoa-atob；
 * Node 22 亦原生支持（单测）。
 */

export async function compressSdp(sdp: string): Promise<string> {
  const bytes = new TextEncoder().encode(sdp)
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'))
  const compressed = await streamToBytes(stream)
  return base64urlEncode(compressed)
}

export async function decompressSdp(encoded: string): Promise<string> {
  const compressed = base64urlDecode(encoded)
  const stream = new Blob([compressed.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  const bytes = await streamToBytes(stream)
  return new TextDecoder().decode(bytes)
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 手动读流：TS7 的 Response body 类型不接受 ReadableStream<Uint8Array> */
async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}
