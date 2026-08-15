import type { DeviceKind } from '../protocol/signaling'

/**
 * 离线配对设备分工（T14，SPEC §5.3 / ADR-0006）。
 *
 * 痛点：电脑（尤其 Windows）没有摄像头，无法扫码；配对来回交换很麻烦。
 * 分工原则：谁有摄像头谁扫码，没摄像头的一方只负责「显示配对码 / 粘贴」。
 * 本文件是纯逻辑（默认主路径 + 引导文案），UI 在 OfflinePair.tsx 消费。
 */

export type PairAction = 'offer' | 'scan'

/** 本端默认主路径：电脑 → 显示配对码（免摄像头）；手机/平板 → 扫码 */
export function primaryPairAction(kind: DeviceKind): PairAction {
  return kind === 'desktop' ? 'offer' : 'scan'
}

export interface PairGuide {
  /** pick 页头部一句话分工说明 */
  headline: string
  /** 三步流程（按本端默认路径；恰好一轮跨设备传输） */
  steps: string[]
  /** 例外提示（同型设备配对 / 无摄像头时的手动路径） */
  note: string
}

export function pairGuide(kind: DeviceKind): PairGuide {
  if (kind === 'desktop') {
    return {
      headline: '电脑端分工：只出码、不扫码',
      steps: [
        '本机显示配对码（下方二维码或文本）',
        '手机扫码本机屏幕（自动进入接收流程）',
        '手机把回码文本发回本机（微信 / 文件传输）粘贴',
      ],
      note: '两台电脑配对：一台「显示配对码」，另一台点「扫码配对」后粘贴对方文本。',
    }
  }
  const headline = kind === 'tablet' ? '平板端分工：扫码进入' : '手机端分工：扫码进入'
  return {
    headline,
    steps: [
      '电脑（或另一台手机）先「显示配对码」',
      '本机扫对方屏幕上的码（自动判定角色）',
      '把本机回码文本发给对方粘贴（微信 / 文件传输）',
    ],
    note: '手机↔手机：一台「显示配对码」，另一台扫码。',
  }
}

/** pick 页两个按钮的文案（按设备类型给主路径加提示后缀；标签集中一处便于测试） */
export interface PairButtonLabels {
  offerLabel: string
  scanLabel: string
}

export function pairButtonLabels(kind: DeviceKind): PairButtonLabels {
  if (kind === 'desktop') {
    return { offerLabel: '显示配对码（免摄像头）', scanLabel: '扫码配对（有摄像头）' }
  }
  return { offerLabel: '显示配对码', scanLabel: '扫码配对' }
}

/**
 * T16/T17 两跳体验打磨（SPEC §5.3 / ADR-0007）的按钮/文案集中处 ——
 * 回码一键分享（answer 端）、断线快捷重配（offer 端）与桌面 offer 页主次重排。
 */
export interface PairPolishLabels {
  /** answer-show（T16）：「分享回码」——navigator.share({ text }) 一键分享到微信/文件传输 */
  shareAnswerLabel: string
  /** 分享失败 / 不支持 / 用户取消时的降级提示（配合「复制配对码」） */
  shareFallbackMsg: string
  /** 断线警告旁（T17）：「重新配对」——一步回本端 offer 页（保持角色，不重走 pick） */
  rePairLabel: string
  /** 断线警告文案（离线断连：重新配对后从 bitfield 断点续传，不重传已收数据） */
  disconnectedWarning: string
  /** answerer 端重新配对时的引导（保持接收角色，等对方重新出码） */
  rePairScanMsg: string
  /** 桌面 offer-show（T17）：粘贴回码——唯一主操作标题 */
  desktopPasteTitle: string
  /** 桌面 offer-show（T17）：扫码入口折叠标题（次要入口，电脑默认免摄像头） */
  desktopScanSummary: string
  /** offer-show：「重新生成」收进角落（电脑端） */
  regenerateLabel: string
  /** offer-show：复制本端配对码 */
  copyCodeLabel: string
  /** offer-show：扫码对方的回码（手机端按钮 / 桌面端折叠入口内） */
  scanAnswerLabel: string
  /** 无摄像头手动粘贴入口（手机 offer-show 粘贴接收端回码） */
  mobilePasteSummary: string
  /** 无摄像头手动粘贴入口（scan-wait 粘贴发送端配对码） */
  scanWaitPasteSummary: string
  /** 扫码激活后的停止按钮 */
  stopScanLabel: string
  /** 扫码未激活时的开始按钮（scan-wait） */
  startScanLabel: string
}

export function pairPolishLabels(): PairPolishLabels {
  return {
    shareAnswerLabel: '分享回码',
    shareFallbackMsg: '未完成分享：请用「复制配对码」发送给对端',
    rePairLabel: '重新配对',
    disconnectedWarning: '⚠ 连接已断开：重新配对后自动续传（只补缺失部分，不重传已收数据）。',
    rePairScanMsg: '重新配对：请对方重新「显示配对码」，本机扫对方的新码',
    desktopPasteTitle: '把手机显示的回码粘贴到这里（电脑主路径）：',
    desktopScanSummary: '有摄像头？扫码对方的回码',
    regenerateLabel: '重新生成',
    copyCodeLabel: '复制配对码',
    scanAnswerLabel: '扫码对方的回码',
    mobilePasteSummary: '没有摄像头？手动粘贴接收端的配对码',
    scanWaitPasteSummary: '没有摄像头？手动粘贴发送端的配对码',
    stopScanLabel: '停止扫码',
    startScanLabel: '开始扫码',
  }
}

/** 离线配对相位（与 OfflinePair 内部 Phase 一致；pairGuide 需要它以编码断线重配语义） */
export type PairPhase = 'pick' | 'offer-show' | 'scan-wait' | 'answer-show' | 'done'

/**
 * T17：断线快捷重配的目标动作（保持本端角色，不重走 pick 页）——
 * offerer 相位（offer-show / done）→ 重新出码；answerer 相位（answer-show / scan-wait）
 * → 保持接收角色等对方重新出码；pick（角色已随收起重置）→ 默认按本端出码开始。
 */
export type RePairAction = 'offer' | 'scan'

export function rePairAction(phase: PairPhase): RePairAction {
  return phase === 'answer-show' || phase === 'scan-wait' ? 'scan' : 'offer'
}
