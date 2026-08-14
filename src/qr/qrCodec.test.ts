import { describe, expect, it } from 'vitest'
import { decodeQrText, encodeQrText } from './qrCodec'
import type { SignalPayload } from '../protocol/signaling'

/** 构造一个内容可压缩的「压缩 SDP」：sdp 字段是 gzip+b64 的文本（RtcPeer 产物） */
async function fakeCompressedSdp(seed: string): Promise<string> {
  const { compressSdp } = await import('../webrtc/sdpCodec')
  return compressSdp(seed)
}

describe('qrCodec — 二维码文本编码/解码（SPEC §5.3）', () => {
  it('offer 往返一致：kind/sdp 不变', async () => {
    const sdp = await fakeCompressedSdp('v=0\r\nc=IN IP4 10.0.0.5\r\na=candidate:1 1 udp 1 host 10.0.0.5 5000 typ host')
    const payload: SignalPayload = { kind: 'offer', sdp }
    const text = await encodeQrText(payload)
    await expect(decodeQrText(text)).resolves.toEqual(payload)
  })

  it('answer 往返一致', async () => {
    const sdp = await fakeCompressedSdp('v=0\r\nc=IN IP4 10.0.0.9\r\na=ice-ufrag:xyz')
    const text = await encodeQrText({ kind: 'answer', sdp })
    await expect(decodeQrText(text)).resolves.toEqual({ kind: 'answer', sdp })
  })

  it('生成文本是 base64url（无 + / =）且比原始 SDP 小（压缩生效）', async () => {
    const raw = 'a=candidate:1 1 udp 1 host 10.0.0.5 5000 typ host\r\n'.repeat(50)
    const sdp = await fakeCompressedSdp(raw)
    const text = await encodeQrText({ kind: 'offer', sdp })
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    // sdp 字段本身已 gzip+b64（RtcPeer 单次装载），套信封后仍远小于原始 SDP
    expect(text.length).toBeLessThan(raw.length)
  })

  it('容忍首尾空白（扫码常见）', async () => {
    const text = await encodeQrText({ kind: 'offer', sdp: await fakeCompressedSdp('v=0') })
    await expect(decodeQrText(`  ${text}\n`)).resolves.toMatchObject({ kind: 'offer' })
  })

  it('空文本 / 非 base64url 文本报错', async () => {
    await expect(decodeQrText('')).rejects.toThrow('配对码为空')
    await expect(decodeQrText('not a qr !!')).rejects.toThrow('格式不正确')
  })

  it('非法 base64url → 解压失败报错', async () => {
    await expect(decodeQrText('abcd')).rejects.toThrow('无法解压')
  })

  it('合法 base64url 但解压失败（非 gzip 内容）→ 报错', async () => {
    // base64url("hello") = aGVsbG8；"hello" 不是合法 gzip 流
    await expect(decodeQrText('aGVsbG8')).rejects.toThrow('无法解压')
  })

  it('JSON 但缺字段 / 版本不匹配 → 报错', async () => {
    const { compressSdp } = await import('../webrtc/sdpCodec')
    const noKind = await compressSdp(JSON.stringify({ v: 1, sdp: 'x' }))
    await expect(decodeQrText(noKind)).rejects.toThrow('kind')
    const badVersion = await compressSdp(JSON.stringify({ v: 99, kind: 'offer', sdp: 'x' }))
    await expect(decodeQrText(badVersion)).rejects.toThrow('版本')
    const noSdp = await compressSdp(JSON.stringify({ v: 1, kind: 'offer', sdp: '' }))
    await expect(decodeQrText(noSdp)).rejects.toThrow('sdp')
  })

  it('超长文本拒绝编码（QR v40-L 容量上限）', async () => {
    // 随机内容不可压缩 → 压缩后仍远超单码容量 → 必须报错而不是生成废码
    const sdp = await fakeCompressedSdp(randomText(120_000))
    await expect(encodeQrText({ kind: 'offer', sdp })).rejects.toThrow('过长')
  })
})

function randomText(len: number): string {
  let out = ''
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}
