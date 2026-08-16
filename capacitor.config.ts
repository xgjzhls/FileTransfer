import type { CapacitorConfig } from '@capacitor/cli'

// ADR-0008：iOS 打包壳（Capacitor 8，SPM 模式）。
// webDir = dist（`npm run build:app` 产物，禁用 SW 注入——壳内 SW 不可用）。
// 原生导出能力由本地插件 plugins/folder-export 提供（cap sync 自动链接/注册）。
const config: CapacitorConfig = {
  appId: 'local.transfer.app',
  appName: 'LocalTransfer',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
    // 与 spike 一致：contentInset automatic 即默认；此处显式声明便于后续调整
  },
}

export default config
