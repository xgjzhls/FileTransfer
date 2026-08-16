/**
 * 局域网可见性开关（ADR-0009 决策 2 / T06，SPEC §5.5）——`lt.lanVisible` 持久化。
 *
 * - 默认开：本机经 mDNS 广告出现在他人「局域网发现」列表，并主动发现（浏览）同网设备
 * - 关：不广告也不浏览——本机对同网设备隐身，也不主动发现（在线房间 / 扫码配对不受影响）
 *
 * storage 可注入（浏览器默认 localStorage；测试用内存实现）——模式同 rooms/session.ts
 * （lt.lastRoom，T12）。存储值 '0' = 关，其余（含缺失）= 开，重启保持。
 */
import type { StorageLike } from '../rooms/session'

/** localStorage 键（与 lt.lastRoom / lt.deviceName 同模式） */
export const LAN_VISIBLE_KEY = 'lt.lanVisible'

/** 浏览器默认存储（仅浏览器环境访问；测试显式注入） */
function defaultStorage(): StorageLike {
  return globalThis.localStorage
}

/** 可见性：默认开；仅存储值 '0' 视为关（重启保持） */
export function getLanVisible(storage: StorageLike = defaultStorage()): boolean {
  return storage.getItem(LAN_VISIBLE_KEY) !== '0'
}

/** 持久化可见性（设置页开关） */
export function setLanVisible(visible: boolean, storage: StorageLike = defaultStorage()): void {
  storage.setItem(LAN_VISIBLE_KEY, visible ? '1' : '0')
}
