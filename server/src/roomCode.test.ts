import { describe, expect, it } from 'vitest'
import { ROOM_CODE_ALPHABET, generateRoomCode } from './roomCode'

describe('roomCode — 房间码生成（SPEC §5.4）', () => {
  it('字母表精确为 32 字符且排除 0/O/1/I 等易混淆字符', () => {
    expect(ROOM_CODE_ALPHABET).toBe('23456789ABCDEFGHJKLMNPQRSTUVWXYZ')
    for (const c of '0O1I') expect(ROOM_CODE_ALPHABET).not.toContain(c)
  })

  it('生成 4 位码，字符全部来自字母表', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode()
      expect(code).toHaveLength(4)
      for (const c of code) expect(ROOM_CODE_ALPHABET).toContain(c)
    }
  })

  it('默认长度 4（SPEC §5.4）', () => {
    expect(generateRoomCode()).toHaveLength(4)
  })
})
