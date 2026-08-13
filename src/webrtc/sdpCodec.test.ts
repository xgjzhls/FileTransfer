import { describe, expect, it } from 'vitest'
import { compressSdp, decompressSdp } from './sdpCodec'

const SAMPLE_SDP =
  'v=0\r\no=- 4611738354456071040 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' +
  'a=group:BUNDLE 0\r\n' +
  'a=candidate:1 1 udp 1 192.168.1.5 54321 typ host\r\n'.repeat(50)

describe('sdpCodec — gzip + base64url（SPEC §5.1/§5.3 共用 payload）', () => {
  it('压缩→解压后与原文一致（含 CRLF 与重复 candidate）', async () => {
    const encoded = await compressSdp(SAMPLE_SDP)
    expect(await decompressSdp(encoded)).toBe(SAMPLE_SDP)
  })

  it('压缩确实变小（候选密集的 SDP 可压 ~90%）', async () => {
    const encoded = await compressSdp(SAMPLE_SDP)
    expect(encoded.length).toBeLessThan(SAMPLE_SDP.length * 0.2)
  })

  it('输出仅含 base64url 字符集 [A-Za-z0-9_-]', async () => {
    const encoded = await compressSdp(SAMPLE_SDP)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('普通文本 SDP 往返一致', async () => {
    const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n'
    const encoded = await compressSdp(sdp)
    expect(await decompressSdp(encoded)).toBe(sdp)
  })

  it('空字符串往返', async () => {
    const encoded = await compressSdp('')
    expect(await decompressSdp(encoded)).toBe('')
  })
})
