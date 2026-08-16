/**
 * 房间会话持久化（T12，SPEC §5.4 / ADR-0006）——「二次使用零操作」。
 *
 * - `lt.deviceId`：设备身份跨**重载**稳定（sessionStorage：同标签页 reload 保留、
 *   新标签页独立）。服务端 join 对同 id 幂等替换连接（room.ts），无幽灵广播。
 *   （2026-08-16 联调发现：原 localStorage 下同源多标签页共享同一 deviceId，
 *   服务端按「重连替换旧连接」把前一个标签页踢掉 → 多标签页互踢振荡；
 *   每标签页独立 WebRTC 端点，身份本就该按标签页隔离。）
 * - `lt.lastRoom`：上次加入的房间码；重开在线时自动重入；「退出房间」（设置页）
 *   清除。Home 路由卸载时信令自然断开（Home 的卸载 effect close reconnect），
 *   故设置页退出只需清 lastRoom，无需跨页事件。
 *
 * storage 参数可注入（浏览器默认：lastRoom 用 localStorage，deviceId 用
 * sessionStorage；测试用内存实现）。
 */

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const DEVICE_ID_KEY = 'lt.deviceId'
const LAST_ROOM_KEY = 'lt.lastRoom'

/** 浏览器默认存储（仅浏览器环境访问；测试显式注入） */
function defaultStorage(): StorageLike {
  return globalThis.localStorage
}

/** 设备身份默认存储：sessionStorage（每标签页独立；跨重载保留） */
function defaultDeviceStorage(): StorageLike {
  if (typeof globalThis !== 'undefined' && globalThis.sessionStorage) {
    return globalThis.sessionStorage
  }
  return defaultStorage()
}

/** 读取或创建设备身份：已持久化则复用（重载同一身份），否则生成并落盘 */
export function getOrCreateDeviceId(storage: StorageLike = defaultDeviceStorage()): string {
  const existing = storage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  storage.setItem(DEVICE_ID_KEY, id)
  return id
}

/** 上次加入的房间码；无则空串 */
export function getLastRoom(storage: StorageLike = defaultStorage()): string {
  return storage.getItem(LAST_ROOM_KEY) ?? ''
}

/** 手动输入新码加入 / 随机生成时更新为当前房间 */
export function setLastRoom(code: string, storage: StorageLike = defaultStorage()): void {
  storage.setItem(LAST_ROOM_KEY, code)
}

/** 退出房间：清除记住的房间码（下次打开不再自动回房） */
export function clearLastRoom(storage: StorageLike = defaultStorage()): void {
  storage.removeItem(LAST_ROOM_KEY)
}
