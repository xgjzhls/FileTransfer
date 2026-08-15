/**
 * capacity —— 传输前容量预警（SPEC §4 [v2] / CONTEXT 关键风险）。
 *
 * 平台差异（spike 实测）：
 * - 桌面（Chrome/Firefox/Android）：`navigator.storage.estimate()` 返回真实
 *   quota/usage → 可用 = quota - usage，可靠。
 * - iOS Safari：estimate() 恒返回 0 → 需用 OPFS 写探测替代：步进写一个
 *   probe 文件到「目标大小」或「失败点」，成功后立即删除；失败点即真实
 *   可用上限（iOS OPFS 配额 ≈ 设备剩余空间）。
 *
 * 本模块纯逻辑（estimate / write 均注入），浏览器 IO 在 capacityProbe
 * worker 中实现 —— 单测不接触浏览器。
 */

export type CapacityMode = 'estimate' | 'probe' | 'unavailable'

export interface CapacityResult {
  mode: CapacityMode
  /** 已知可靠可用字节（estimate=quota-usage；probe=探测成功字节；unavailable=0） */
  availableBytes: number
  reliable: boolean
  /** probe 模式的探测上限（超出部分未验证；estimate/unavailable 无） */
  probeCapBytes?: number
}

export interface CapacityVerdict {
  ok: boolean
  message: string
  /** 界面层级：ok=充足（可静默）；info=无法预检（提示不阻断）；warn=不足（醒目警告） */
  level: 'ok' | 'info' | 'warn'
}

/**
 * 从 estimate() 结果提取可用容量。
 * iOS 恒 0（quota<=0）→ { availableBytes: 0, reliable: false }（调用方转探测）。
 */
export function usableFromEstimate(
  estimate: { usage?: number; quota?: number } | null | undefined,
): { availableBytes: number; reliable: boolean } {
  if (!estimate) return { availableBytes: 0, reliable: false }
  const quota = estimate.quota ?? 0
  const usage = estimate.usage ?? 0
  if (quota <= 0) return { availableBytes: 0, reliable: false } // iOS 恒 0
  return { availableBytes: Math.max(0, quota - usage), reliable: true }
}

/**
 * 探测计划：返回每次探测要写到的累计字节（步进 step，末步可能不满）。
 * 探测总目标 = min(target, cap)；target/cap ≤ 0 → 空计划。
 * 例 planProbeBytes(100, 64, 200) = [64, 100]；planProbeBytes(300, 64, 200) = [64, 128, 192, 200]。
 */
export function planProbeBytes(targetBytes: number, stepBytes: number, capBytes: number): number[] {
  if (targetBytes <= 0 || stepBytes <= 0 || capBytes <= 0) return []
  const limit = Math.min(targetBytes, capBytes)
  const plan: number[] = []
  for (let done = 0; done < limit; ) {
    const next = Math.min(done + stepBytes, limit)
    plan.push(next)
    done = next
  }
  return plan
}

/**
 * 注入式写探测循环：沿计划步进写，失败（返回 false 或抛错）即停。
 * 返回最后成功字节 + 是否全部成功；清理函数无论成败都执行（删除 probe 文件）。
 */
export async function probeAvailable(
  plan: number[],
  write: (offset: number, bytes: number) => Promise<boolean>,
  clear: () => Promise<void> = async () => {},
): Promise<{ availableBytes: number; ok: boolean }> {
  let done = 0
  for (const target of plan) {
    const bytes = target - done
    let ok = false
    try {
      ok = await write(done, bytes)
    } catch {
      ok = false
    }
    if (!ok) break
    done = target
  }
  await clear()
  return { availableBytes: done, ok: done === (plan[plan.length - 1] ?? 0) }
}

/**
 * 容量结论判定：
 * - estimate 可靠：available ≥ target → ok；否则 not ok。
 * - probe：探测到目标全部可写 → ok；目标 ≤ 探测上限且不足 → not ok
 *   （失败点即真实上限）；目标超出探测上限 → ok 但提示无法精确预检
 *   （大文件，运行时 QuotaExceededError 由续传兜底）。
 * - unavailable：不阻断，提示无法预检。
 */
export function interpretCapacity(targetBytes: number, cap: CapacityResult): CapacityVerdict {
  if (cap.mode === 'unavailable' || !cap.reliable) {
    return {
      ok: true,
      level: 'info',
      message: '无法预检存储空间（当前浏览器限制）；传输中断后自动续传，已收数据保留',
    }
  }
  if (cap.availableBytes >= targetBytes) {
    return { ok: true, level: 'ok', message: `存储空间充足（约 ${fmtBytes(cap.availableBytes)} 可用）` }
  }
  // 探测模式且目标超出探测上限：仅当探测**成功到达上限**时才是「未验证部分」→ info；
  // 若探测在上限内失败（失败点即真实上限），一律 warn（精确不足）
  if (
    cap.mode === 'probe' &&
    cap.probeCapBytes !== undefined &&
    targetBytes > cap.probeCapBytes &&
    cap.availableBytes >= cap.probeCapBytes
  ) {
    return {
      ok: true,
      level: 'info',
      message: `已验证至少 ${fmtBytes(cap.availableBytes)} 可写；目标 ${fmtBytes(targetBytes)} 更大，iOS 限制无法精确预检（建议确保设备剩余空间充足；中断后可续传）`,
    }
  }
  return {
    ok: false,
    level: 'warn',
    message: `存储空间可能不足：需要约 ${fmtBytes(targetBytes)}，可用约 ${fmtBytes(cap.availableBytes)}。建议先导出/清理已收数据再接收；中断后自动续传，已收部分不丢`,
  }
}

/** 文案用字节格式化（与 UI formatBytes 语义一致；本模块自包含便于单测） */
export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, n)} B`
}
