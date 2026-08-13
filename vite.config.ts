import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: './', // GitHub Pages 子路径部署（/FileTransfer/）
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
