/**
 * 发现设备注册表（ADR-0009 / T02）。
 *
 * mDNS 消失检测依赖 TTL（默认 120s），NWBrowser 的 .removed 通知可能滞后或缺失
 * （网络抖动、app 挂起）——列表按「最后看到时间」清理而非即时移除：
 * `pruneStale(ttlMs, now)` 兜底，与原生 .removed 事件（DeviceRegistry.remove）互补。
 *
 * 纯 JS、无 @capacitor 依赖；时间戳由调用方注入（now），便于单测与时钟控制。
 */
import type { DeviceInfo } from './txt'

/** 原生浏览事件吐出的设备载荷（无时间戳） */
export type LanDevice = DeviceInfo & {
  /** Bonjour 服务实例名（= 对端 deviceId；T04 解析端点用） */
  serviceName: string
  /** Bonjour 域（通常 "local."） */
  domain: string
}

export interface TrackedDevice extends LanDevice {
  firstSeen: number
  lastSeen: number
}

export class DeviceRegistry {
  private readonly devices = new Map<string, TrackedDevice>()

  /** 新增或刷新；已有设备保留 firstSeen、更新 lastSeen 与载荷 */
  add(device: LanDevice, now: number): TrackedDevice {
    const existing = this.devices.get(device.id)
    const entry: TrackedDevice = existing
      ? { ...existing, ...device, firstSeen: existing.firstSeen, lastSeen: now }
      : { ...device, firstSeen: now, lastSeen: now }
    this.devices.set(device.id, entry)
    return entry
  }

  /** 更新 lastSeen（如 .changed 事件重报）；未知 id 返回 false */
  touch(id: string, now: number): boolean {
    const d = this.devices.get(id)
    if (!d) return false
    d.lastSeen = now
    return true
  }

  /** 原生 .removed 通知时移除；未知 id 返回 false */
  remove(id: string): boolean {
    return this.devices.delete(id)
  }

  get(id: string): TrackedDevice | undefined {
    return this.devices.get(id)
  }

  /** 全部设备（插入序） */
  list(): TrackedDevice[] {
    return [...this.devices.values()]
  }

  /**
   * 清理 `now - lastSeen >= ttlMs` 的设备（含边界），返回被移除的 id。
   * mDNS TTL 兜底：即使没收到 .removed，超时未见的设备也从列表消失。
   */
  pruneStale(ttlMs: number, now: number): string[] {
    const cutoff = now - ttlMs
    const removed: string[] = []
    for (const [id, d] of this.devices) {
      if (d.lastSeen <= cutoff) {
        this.devices.delete(id)
        removed.push(id)
      }
    }
    return removed
  }
}
