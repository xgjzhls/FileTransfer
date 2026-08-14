/**
 * 离线二维码信令编码（SPEC §5.3）。
 *
 * QR 文本 = base64url( gzip( { "v":1, "kind":"offer"|"answer", "sdp":"<sdp>" } ) )
 *
 * 与 WS 信令共用同一个 signal.payload 结构（单协议双载体，ADR-0004）：
 * payload.sdp 已是 gzip+b64 的压缩 SDP（RtcPeer 单次装载），此处套一层
 * 版本化 JSON 信封再整体 gzip+b64 —— 供摄像头 / 手动粘贴两种方式交换。
 */

import { compressSdp, decompressSdp } from '../webrtc/sdpCodec'
import type { SignalPayload } from '../protocol/signaling'

/** 信封版本（SPEC §5.3：v:1） */
export const QR_FORMAT_VERSION = 1

interface QrEnvelope {
  v: number
  kind: 'offer' | 'answer'
  sdp: string
}

/**
 * 单码容量上限（QR v40-L ≈ 2953 字节二进制；base64url 膨胀 4/3，留余量）。
 * 超限直接报错提示重试，避免生成无法扫描的码。
 */
export const MAX_QR_TEXT_CHARS = 2800

/** 编码为可扫二维码的文本（信封 JSON → gzip+b64，与 WS 共用同一压缩管线） */
export async function encodeQrText(payload: SignalPayload): Promise<string> {
  const envelope: QrEnvelope = { v: QR_FORMAT_VERSION, kind: payload.kind, sdp: payload.sdp }
  const text = await compressSdp(JSON.stringify(envelope))
  if (text.length > MAX_QR_TEXT_CHARS) {
    throw new Error(
      `配对码过长（${text.length} 字符，上限 ${MAX_QR_TEXT_CHARS}）。候选地址过多，请重试或改用在线信令配对。`,
    )
  }
  return text
}

/** 解码二维码文本（校验格式与版本；非法内容抛错） */
export async function decodeQrText(text: string): Promise<SignalPayload> {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('配对码为空')
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error('配对码格式不正确（应为 base64url 文本）')
  }
  let json: string
  try {
    json = await decompressSdp(trimmed)
  } catch {
    throw new Error('配对码无法解压，可能被截断或不是 LocalTransfer 配对码')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('配对码内容无效（不是 LocalTransfer 配对码）')
  }
  return validateEnvelope(parsed)
}

function validateEnvelope(value: unknown): SignalPayload {
  if (typeof value !== 'object' || value === null) throw new Error('配对码内容无效')
  const env = value as Partial<QrEnvelope>
  if (env.v !== QR_FORMAT_VERSION) throw new Error(`不支持的配对码版本（v=${String(env.v)}，请升级应用）`)
  if (env.kind !== 'offer' && env.kind !== 'answer') throw new Error('配对码缺少 kind 字段')
  if (typeof env.sdp !== 'string' || env.sdp.length === 0) throw new Error('配对码缺少 sdp 字段')
  return { kind: env.kind, sdp: env.sdp }
}
