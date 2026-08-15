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
