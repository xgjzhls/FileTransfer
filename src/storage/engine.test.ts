import { describe, expect, it } from 'vitest'
import { MemorySyncFs } from './memorySyncFs'
import { StorageEngine } from './engine'
import { sha256Hex } from './engine'

const enc = new TextEncoder()

function setup() {
  const fs = new MemorySyncFs()
  const engine = new StorageEngine(fs)
  return { fs, engine }
}

/** Open a part writer, write [offset, text] chunks in order, close. */
async function writeTextPart(
  engine: StorageEngine,
  sessionId: string,
  fileId: number,
  partIndex: number,
  chunks: Array<[number, string]>,
): Promise<void> {
  const writer = await engine.openPart(sessionId, fileId, partIndex)
  for (const [offset, text] of chunks) {
    engine.writeChunk(writer, offset, enc.encode(text))
  }
  engine.closeWriter(writer)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('StorageEngine — part 写入', () => {
  it('连续 chunk 按各自偏移写入，读回即拼接原文', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [
      [0, 'hello'],
      [5, 'world'],
    ])
    expect(decode(await engine.readPart('s1', 0, 0))).toBe('helloworld')
  })

  it('稀疏写入：空洞以零填充', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[100, 'end']])
    const bytes = await engine.readPart('s1', 0, 0)
    expect(bytes.length).toBe(103)
    expect(bytes.slice(0, 100)).toEqual(new Uint8Array(100))
    expect(decode(bytes.slice(100))).toBe('end')
  })

  it('重叠偏移覆盖旧字节', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [
      [0, 'aaaa'],
      [1, 'bb'],
    ])
    expect(decode(await engine.readPart('s1', 0, 0))).toBe('abba')
  })

  it('不同 part 文件互不干扰', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[0, 'first']])
    await writeTextPart(engine, 's1', 1, 0, [[0, 'second']])
    await writeTextPart(engine, 's2', 0, 1, [[0, 'third']])
    expect(decode(await engine.readPart('s1', 0, 0))).toBe('first')
    expect(decode(await engine.readPart('s1', 1, 0))).toBe('second')
    expect(decode(await engine.readPart('s2', 0, 1))).toBe('third')
  })

  it('同一 part 重复打开（续传覆盖）后以最新写入为准', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[0, 'AAAA']])
    await writeTextPart(engine, 's1', 0, 0, [[2, 'bb']])
    expect(decode(await engine.readPart('s1', 0, 0))).toBe('AAbb')
  })
})

// 独立基准值（openssl dgst -sha256 生成，非被测代码计算）
const SHA256_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const SHA256_HELLOWORLD = '936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af'
const SHA256_PAYLOAD =
  '9af46efbbee373aa1860cbacadbbb7bbe797ccc01ae8361f8de46046a7c5f937'
const MERGE_PAYLOAD = 'LocalTransfer merge test payload 0123456789 abcdefghijklmnopqrstuvwxyz'

describe('StorageEngine — part 校验（SHA-256）', () => {
  it('finalizePart：哈希一致时返回 ok，actual 为基准值', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[0, 'hello']])
    const r = await engine.finalizePart('s1', 0, 0, SHA256_HELLO)
    expect(r).toEqual({ ok: true, actual: SHA256_HELLO })
  })

  it('finalizePart：哈希不符时返回 ok:false 且给出实际哈希', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[0, 'hello']])
    const r = await engine.finalizePart('s1', 0, 0, '0'.repeat(64))
    expect(r.ok).toBe(false)
    expect(r.actual).toBe(SHA256_HELLO)
  })
})

describe('StorageEngine — merge 拼接', () => {
  it('两个 part 拼接后内容与 SHA-256 均与源一致', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[0, 'hello']])
    await writeTextPart(engine, 's1', 0, 1, [[0, 'world']])
    await engine.merge('s1', 0, 'out.txt', 2)
    expect(decode(await engine.readMerged('s1', 0, 'out.txt'))).toBe('helloworld')
    expect(await sha256Hex(await engine.readMerged('s1', 0, 'out.txt'))).toBe(SHA256_HELLOWORLD)
  })

  it('多 part 合并（含未满 part）后哈希与整段基准值一致', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[0, 'LocalTransfer ']])
    await writeTextPart(engine, 's1', 0, 1, [[0, 'merge test payload ']])
    await writeTextPart(engine, 's1', 0, 2, [[0, '0123456789 abcdefghijklmnopqrstuvwxyz']])
    await engine.merge('s1', 0, 'payload.bin', 3)
    expect(decode(await engine.readMerged('s1', 0, 'payload.bin'))).toBe(MERGE_PAYLOAD)
    expect(await sha256Hex(await engine.readMerged('s1', 0, 'payload.bin'))).toBe(SHA256_PAYLOAD)
  })

  it('尾 part 为空时拼接结果不变', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[0, 'hello']])
    await writeTextPart(engine, 's1', 0, 1, [])
    await engine.merge('s1', 0, 'out.txt', 2)
    expect(decode(await engine.readMerged('s1', 0, 'out.txt'))).toBe('hello')
  })

  it('merge 后 part 文件保留（供 T06 续传）', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 's1', 0, 0, [[0, 'hello']])
    await writeTextPart(engine, 's1', 0, 1, [[0, 'world']])
    await engine.merge('s1', 0, 'out.txt', 2)
    expect(decode(await engine.readPart('s1', 0, 0))).toBe('hello')
    expect(decode(await engine.readPart('s1', 0, 1))).toBe('world')
  })
})

describe('StorageEngine — 清理', () => {
  it('listSessions 报告各会话占用字节数', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 'aaa', 0, 0, [[0, 'hello']])
    await writeTextPart(engine, 'aaa', 0, 1, [[0, 'world']])
    await writeTextPart(engine, 'bbb', 0, 0, [[0, 'x']])
    const sessions = await engine.listSessions()
    expect(sessions).toHaveLength(2)
    const byId = new Map(sessions.map((s) => [s.sessionId, s.bytes]))
    expect(byId.get('aaa')).toBe(10)
    expect(byId.get('bbb')).toBe(1)
  })

  it('deleteSession 只删指定会话', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 'aaa', 0, 0, [[0, 'hello']])
    await writeTextPart(engine, 'bbb', 0, 0, [[0, 'world']])
    await engine.deleteSession('aaa')
    const sessions = await engine.listSessions()
    expect(sessions.map((s) => s.sessionId)).toEqual(['bbb'])
    expect(decode(await engine.readPart('bbb', 0, 0))).toBe('world')
  })

  it('deleteAll 清空全部会话，且幂等', async () => {
    const { engine } = setup()
    await writeTextPart(engine, 'aaa', 0, 0, [[0, 'hello']])
    await writeTextPart(engine, 'bbb', 0, 0, [[0, 'world']])
    await engine.deleteAll()
    expect(await engine.listSessions()).toEqual([])
    // 幂等：再次执行不抛错、仍为空
    await engine.deleteAll()
    expect(await engine.listSessions()).toEqual([])
  })
})
