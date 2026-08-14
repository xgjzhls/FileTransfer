/**
 * 发送端进度缓存（SPEC §3.5 / T06 US-9）。
 *
 * 非权威、可丢：localStorage 缓存「每文件已完成 part 数」，发送端页面重载后
 * 重新选文件时用于恢复进度显示。键 = `${name}:${size}`。
 */

const KEY = 'lt.sendProgress'

export type SendProgressCache = Record<string, number>

export function getSendProgress(): SendProgressCache {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as SendProgressCache) : {}
  } catch {
    return {}
  }
}

export function setSendProgress(name: string, size: number, doneParts: number): void {
  try {
    const cache = getSendProgress()
    cache[`${name}:${size}`] = doneParts
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* 尽力而为 */
  }
}

export function clearSendProgress(name?: string, size?: number): void {
  try {
    if (name === undefined || size === undefined) {
      localStorage.removeItem(KEY)
      return
    }
    const cache = getSendProgress()
    delete cache[`${name}:${size}`]
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* 尽力而为 */
  }
}
