import { describe, expect, it } from 'vitest'
import { isValidPin, PIN_ALPHABET, PIN_LENGTH, sanitizePin } from './roomCode'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../server/src/roomCode'

describe('roomCode — 客户端 PIN 输入约束（T11，SPEC §5.4 / ADR-0006）', () => {
  describe('与服务端字母表一致性', () => {
    it('客户端 PIN_ALPHABET 与服务端 ROOM_CODE_ALPHABET 完全一致（防漂移）', () => {
      expect(PIN_ALPHABET).toBe(ROOM_CODE_ALPHABET)
      expect(PIN_LENGTH).toBe(ROOM_CODE_LENGTH)
    })
  })

  describe('sanitizePin', () => {
    it('保留合法字母表字符并大写（小写→大写）', () => {
      expect(sanitizePin('abcd')).toBe('ABCD')
      expect(sanitizePin('k7q2')).toBe('K7Q2')
      expect(sanitizePin('9xYz')).toBe('9XYZ')
    })

    it('剔除易混淆字符 0/O/1/I', () => {
      expect(sanitizePin('0O1I')).toBe('')
      expect(sanitizePin('A0B1C')).toBe('ABC')
      expect(sanitizePin('0K7Q2O')).toBe('K7Q2')
    })

    it('剔除空白与标点等非法字符', () => {
      expect(sanitizePin('12 34')).toBe('234')
      expect(sanitizePin('K7-Q2')).toBe('K7Q2')
      expect(sanitizePin('')).toBe('')
    })

    it('字母表不含 0/O/1/I（32 字符）', () => {
      expect(PIN_ALPHABET).toHaveLength(32)
      expect(PIN_ALPHABET).not.toMatch(/[01OI]/)
    })
  })

  describe('isValidPin', () => {
    it('4 位合法码为真', () => {
      expect(isValidPin('K7Q2')).toBe(true)
      expect(isValidPin('ABCD')).toBe(true)
      expect(isValidPin('2345')).toBe(true)
    })

    it('长度不足/超长为假', () => {
      expect(isValidPin('')).toBe(false)
      expect(isValidPin('ABC')).toBe(false)
      expect(isValidPin('ABCDE')).toBe(false)
    })

    it('含易混淆或非法字符为假', () => {
      expect(isValidPin('0ABC')).toBe(false)
      expect(isValidPin('ABCI')).toBe(false)
      expect(isValidPin('ABCO')).toBe(false)
      expect(isValidPin('AB1C')).toBe(false)
      expect(isValidPin('ab c')).toBe(false)
    })

    it('PIN_LENGTH 为 4', () => {
      expect(PIN_LENGTH).toBe(4)
    })
  })
})
