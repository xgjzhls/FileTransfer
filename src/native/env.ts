/**
 * 平台检测（ADR-0008）：壳内（Capacitor iOS）判定。
 * web 构建（浏览器 / PWA）为 false —— 导出路径保持桌面 FSA / zip / 分享不变。
 */
import { Capacitor } from '@capacitor/core'

export const IS_NATIVE = Capacitor.isNativePlatform()
