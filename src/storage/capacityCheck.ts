/**
 * checkIncomingCapacity —— 传输前容量检查编排（SPEC §4 [v2]）。
 *
 * 策略（estimate 优先，iOS 降级探测，全部失败不阻断）：
 * 1. `navigator.storage.estimate()` 可靠（桌面）→ 可用 = quota - usage，直接判定。
 * 2. 不可靠（iOS estimate 恒 0）→ OPFS 写探测 worker：步进写到目标/失败点，
 *    返回「最后成功字节」= 真实可用下限。
 * 3. 探测也失败（OPFS 不可用/worker 异常）→ 返回「无法预检」提示，不阻断接收
 *    （传输中 QuotaExceededError 有明确提示 + bitfield 续传兜底）。
 *
 * deps 可注入（单测用假 estimate / 假 probe；生产走浏览器 API）。
 */

import {
  usableFromEstimate,
  interpretCapacity,
  planProbeBytes,
} from './capacity'
import type { CapacityResult, CapacityVerdict } from './capacity'

/**
 * 探测步进 64 MiB（spike 实测写速下可接受）。
 * PROBE_CAP_BYTES 仅封顶「预检写盘」本身（省时：为超大文件全量写盘预检反而慢），
 * 不是传输大小上限——目标超出封顶时按「已验证至少 X 可写」提示，从不阻断接收。
 */
export const PROBE_STEP_BYTES = 64 * 1024 * 1024
export const PROBE_CAP_BYTES = 2 * 1024 * 1024 * 1024

export interface ProbeResult {
  availableBytes: number
  probeCapBytes: number
}

export interface CapacityCheckDeps {
  estimate?: () => Promise<{ usage?: number; quota?: number } | null>
  runProbe?: (targetBytes: number) => Promise<ProbeResult>
}

/**
 * worker done 消息 → ProbeResult（纯函数，可单测）。
 * 语义：写失败（含 QuotaExceededError）= 正常结果（失败点即真实上限），
 * error 但 availableBytes > 0 仍 resolve；仅环境错误（OPFS 不可用，0 字节）抛错。
 */
export function probeResultFromMessage(data: {
  type?: string
  availableBytes: number
  error: string | null
}): ProbeResult {
  if (data.error && data.availableBytes <= 0) throw new Error(data.error)
  return { availableBytes: data.availableBytes, probeCapBytes: PROBE_CAP_BYTES }
}

/** 生产实现：OPFS 探测 worker（iOS estimate 恒 0 的替代） */
export async function probeWithWorker(targetBytes: number): Promise<ProbeResult> {
  const worker = new Worker(new URL('./capacityProbeWorker.ts', import.meta.url), { type: 'module' })
  try {
    const result = await new Promise<ProbeResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ type: string; availableBytes: number; error: string | null }>) => {
        if (e.data.type !== 'done') return
        try {
          resolve(probeResultFromMessage(e.data))
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      worker.onerror = (e) => reject(new Error(e.message || 'capacity probe worker error'))
      worker.postMessage({ type: 'start', targetBytes, stepBytes: PROBE_STEP_BYTES, capBytes: PROBE_CAP_BYTES })
    })
    return result
  } finally {
    worker.terminate()
  }
}

/**
 * 接收前容量检查：返回判定 + 人类可读文案。
 * targetBytes ≤ 0（空清单）→ 不检查，直接 ok。
 */
export async function checkIncomingCapacity(
  targetBytes: number,
  deps: CapacityCheckDeps = {},
): Promise<CapacityVerdict> {
  if (targetBytes <= 0) return { ok: true, level: 'ok' as const, message: '' }

  // 1. estimate 优先
  const estimate = deps.estimate ?? (async () => navigator.storage.estimate())
  try {
    const { availableBytes, reliable } = usableFromEstimate(await estimate())
    if (reliable) {
      return interpretCapacity(targetBytes, { mode: 'estimate', availableBytes, reliable })
    }
  } catch {
    /* estimate 异常 → 走探测 */
  }

  // 2. 探测（iOS fallback）
  const runProbe = deps.runProbe ?? probeWithWorker
  try {
    const { availableBytes, probeCapBytes } = await runProbe(targetBytes)
    // 探测计划为空（target≤0 已在上方拦截；cap≤0 异常）→ 视为不可用
    if (planProbeBytes(targetBytes, PROBE_STEP_BYTES, probeCapBytes).length === 0) {
      return interpretCapacity(targetBytes, { mode: 'unavailable', availableBytes: 0, reliable: false })
    }
    const result: CapacityResult = { mode: 'probe', availableBytes, reliable: true, probeCapBytes }
    return interpretCapacity(targetBytes, result)
  } catch {
    // 3. 探测失败（OPFS 不可用等）：不阻断，提示无法预检
    return interpretCapacity(targetBytes, { mode: 'unavailable', availableBytes: 0, reliable: false })
  }
}
