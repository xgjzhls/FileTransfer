/**
 * 房间码生成（SPEC §5.4）：服务端生成 4 字符码，
 * 排除易混淆字符（0/O、1/I），字母表 32 字符 → 约 100 万组合。
 */

export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const ROOM_CODE_LENGTH = 4

export function generateRoomCode(length: number = ROOM_CODE_LENGTH): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
  }
  return out
}
