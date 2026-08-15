/**
 * 客户端房间码（对称 PIN）输入约束（T11，SPEC §5.4 / ADR-0006）。
 *
 * 与服务端 `ROOM_CODE_ALPHABET`（server/src/roomCode.ts）同字母表：
 * 排除易混淆字符 0/O、1/I 后的 32 字符大写字母表。输入即时剔除非法字符，
 * 非法码在客户端就无法提交（服务端 ROOM_CODE_RE 校验仅作兜底）。
 */

export const PIN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const PIN_LENGTH = 4

const PIN_ALPHABET_SET = new Set(PIN_ALPHABET)

/** 仅保留字母表内字符并转大写（自动剔除 0/O/1/I、空白、标点等） */
export function sanitizePin(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const up = ch.toUpperCase()
    if (PIN_ALPHABET_SET.has(up)) out += up
    if (out.length === PIN_LENGTH) break
  }
  return out
}

/** 是否 4 位合法房间码（客户端提交门槛；服务端 ROOM_CODE_RE 兜底） */
export function isValidPin(code: string): boolean {
  if (code.length !== PIN_LENGTH) return false
  for (const ch of code) {
    if (!PIN_ALPHABET_SET.has(ch)) return false
  }
  return true
}
