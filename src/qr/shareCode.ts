/**
 * 回码全屏 + 一键分享（T16，SPEC §5.3 两跳体验打磨 / ADR-0007）——
 * answer 端回码二维码放大 + navigator.share 文本分享的纯逻辑模块（可单测）。
 *
 * 痛点：回码是第二跳（offer 端回扫/回拍）的唯一载体——码太小回扫失败率高；
 * 手机端把回码发回电脑要「复制 → 切 app → 粘贴」手动三步。本模块提供：
 * 1. answerQrMaxWidth()：回码二维码放大至可用屏宽（min(80vw, 360px)）
 * 2. sharePairCode()：分享 vs 复制 的降级选择（支持 / 不支持 / 失败 / 取消）
 *
 * UI 在 OfflinePair.tsx 消费（answer-show 相位），本文件不依赖 React / navigator。
 */

/** 回码二维码宽度（T16）：放大至可用屏宽，上限 360px（原 260px，offer 端回扫失败率高） */
export function answerQrMaxWidth(): string {
  return 'min(80vw, 360px)'
}

export type ShareTextOutcome = 'shared' | 'copy'

export interface ShareTextCapability {
  /** navigator.share 是否可用（需安全上下文 / 现代浏览器；否则直接降级复制） */
  supported: boolean
  /** 分享实现（UI 注入 navigator.share({ text })；单测注入桩） */
  share: (text: string) => Promise<void>
}

/**
 * 分享 vs 复制的选择逻辑：
 * - 支持且分享成功 → 'shared'
 * - 不支持 / 分享抛错 / 用户取消（AbortError）→ 'copy'（降级为「复制配对码」，不报错中断）
 */
export async function sharePairCode(
  text: string,
  cap: ShareTextCapability,
): Promise<ShareTextOutcome> {
  if (!cap.supported) return 'copy'
  try {
    await cap.share(text)
    return 'shared'
  } catch {
    return 'copy'
  }
}

/** 从运行环境探测分享能力（node 测试环境 / 非安全上下文 → supported=false） */
export function detectShareCapability(): ShareTextCapability {
  const nav = globalThis.navigator as
    | { share?: (data: { text: string }) => Promise<void> }
    | undefined
  return {
    supported: typeof nav?.share === 'function',
    share: (text) => {
      if (!nav?.share) return Promise.reject(new Error('navigator.share unavailable'))
      return nav.share({ text })
    },
  }
}
