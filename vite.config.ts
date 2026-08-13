import { defineConfig } from 'vitest/config'
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

// https://vite.dev/config/
export default defineConfig({
  base: './', // GitHub Pages 子路径部署（/FileTransfer/）
  server: {
    host: true,
    ...(httpsOptions ? { https: httpsOptions } : {}),
  },
  plugins: [
    react(),
    VitePWA({
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
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/src/**/*.test.ts'],
  },
})
