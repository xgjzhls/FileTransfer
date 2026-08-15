/**
 * 扫码自动角色判定（T13，SPEC §5.3 轻量打磨 / ADR-0006）。
 *
 * 免选角色：接收端直接扫码，按解码出的码型（offer/answer）自动判定本端流程。
 * 方向性约束：offer 必须先于 answer 存在（发送端先「显示配对码」）——
 * 扫到与当前角色不符的码时给出明确错误，但扫码器保持运行可继续重扫。
 */

export type ScanPhase = 'scan-wait' | 'offer-show'

export type ScanOutcome =
  | { action: 'answer' } // 本端是接收端：接受 offer 并生成 answer 回码
  | { action: 'complete' } // 本端是发送端：已收到对方 answer，配对完成
  | { action: 'error'; message: string } // 码型与当前角色不符（不中断扫码）

/**
 * 按解码出的码型 + 当前扫码所处相位，判定下一步动作。
 * 扫码/粘贴共用（payload 解码后进入同一路由）。
 */
export function routeScannedCode(kind: 'offer' | 'answer', phase: ScanPhase): ScanOutcome {
  if (phase === 'scan-wait') {
    // 接收端（或未定角色）扫到 offer → 自动走 answer 流程
    if (kind === 'offer') return { action: 'answer' }
    // 扫到 answer：说明对方是接收端，而本端尚未生成 offer —— 方向性约束
    return {
      action: 'error',
      message: '这是接收端回码：需先由发送端「显示配对码」生成 offer 码，再由接收端扫码',
    }
  }
  // offer-show：本端是发送端，等待对方的 answer
  if (kind === 'answer') return { action: 'complete' }
  return {
    action: 'error',
    message: '扫错了：这是发送端配对码（offer），应由接收端扫码；请扫接收端显示的回码',
  }
}
