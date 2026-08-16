/**
 * 局域网发现 TXT 记录（RFC 6763）校验与编码（ADR-0009 / T02）。
 *
 * TXT schema（SPEC §5.5）：name（设备名）/ id（deviceId uuid）/ kind（phone|tablet|
 * desktop）/ port（信令端口，T04 用）/ ver。值 UTF-8 且 ≤255 字节；属性名 ≤9 字符
 * （本 schema 全 ≤4）。跨平台（Android NsdManager，T03）共用此 schema。
 *
 * 纯函数、无 @capacitor 依赖 —— 便于单测；原生侧（Swift）另有兜底校验。
 */

export const SERVICE_TYPE = '_localtranfer._tcp'

/** SPEC §5.3/§5.5 设备分工（与 src/device.ts detectKind 语义对齐，此处仅收 3 类） */
export type DeviceKind = 'phone' | 'tablet' | 'desktop'

export const LAN_KINDS: readonly DeviceKind[] = ['phone', 'tablet', 'desktop']

/** RFC 6763 §6.4：单个 TXT 值上限（UTF-8 字节） */
export const TXT_VALUE_MAX_BYTES = 255

export interface DeviceInfo {
  /** 设备显示名（写入 TXT["name"]） */
  name: string
  /** deviceId uuid（写入 TXT["id"]；Bonjour 实例名也用 id，稳定唯一） */
  id: string
  kind: DeviceKind
  /** 信令端口（T04 原生信令通道用；1..65535） */
  port: number
  ver: string
}

/** 广告参数非法（TXT 契约破坏 / 类型错误）时抛出的错误 */
export class LanOptionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LanOptionsError'
  }
}

export function byteLengthUtf8(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/**
 * 校验 startAdvertising 参数是否符合 TXT schema；非法即抛 LanOptionsError
 * （facade 在委托原生前调用，非法参数先于原生被拦）。
 */
export function validateAdvertisingOptions(options: unknown): asserts options is DeviceInfo {
  if (typeof options !== 'object' || options === null) {
    throw new LanOptionsError('参数必须是对象')
  }
  const info = options as Record<string, unknown>
  const problems: string[] = []
  for (const key of ['name', 'id', 'ver'] as const) {
    const v = info[key]
    if (typeof v !== 'string' || v.trim() === '') {
      problems.push(`${key} 必须是非空字符串`)
    } else if (byteLengthUtf8(v) > TXT_VALUE_MAX_BYTES) {
      problems.push(`${key} 超过 ${TXT_VALUE_MAX_BYTES} 字节（UTF-8）`)
    }
  }
  if (!LAN_KINDS.includes(info.kind as DeviceKind)) {
    problems.push(`kind 必须是 ${LAN_KINDS.join('/')}`)
  }
  if (typeof info.port !== 'number' || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) {
    problems.push('port 必须是 1..65535 整数')
  }
  if (problems.length > 0) {
    throw new LanOptionsError(problems.join('；'))
  }
}
