import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

// 手机局域网测试：VITE_HTTPS=1 启用 https + 监听 0.0.0.0（证书见 .local-certs/）
const isHttps = process.env.VITE_HTTPS === '1'
const httpsOptions = isHttps
  ? {
      key: readFileSync('.local-certs/server.key'),
      cert: readFileSync('.local-certs/server.crt'),
    }
  : undefined

// ADR-0008：app 构建（LT_APP_BUILD=1）禁用 vite-plugin-pwa —— Service Worker 在
// Capacitor/WKWebView 不可用（非 http(s) scheme），壳内离线由本地打包资源承担。
// main.tsx 静态 import 'virtual:pwa-register'，禁用时用无操作 stub 顶替保证编译通过。
const isAppBuild = process.env.LT_APP_BUILD === '1'
function pwaStubPlugin(): Plugin {
  return {
    name: 'pwa-stub',
    resolveId(id) {
      if (id === 'virtual:pwa-register') return '\0pwa-stub'
    },
    load(id) {
      if (id === '\0pwa-stub') return 'export const registerSW = () => {}'
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './', // GitHub Pages 子路径部署（/FileTransfer/）
  server: {
    host: true,
    ...(httpsOptions ? { https: httpsOptions } : {}),
  },
  plugins: [
    react(),
    ...(isAppBuild ? [pwaStubPlugin()] : [VitePWA({
      strategies: 'injectManifest',
      registerType: 'autoUpdate',
      manifest: {
        name: 'LocalTransfer',
        short_name: 'LocalTransfer',
        description: '局域网 P2P 文件传输',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: './favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    })]),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'plugins/**/*.test.ts', 'server/src/**/*.test.ts'],
    // sender 测试含 512MiB 分配 + SHA-256，CPU 争抢（并行 dev 服务）下易超 5s 默认值
    testTimeout: 15000,
  },
})
