import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: './', // GitHub Pages 子路径部署（/FileTransfer/）
  plugins: [react()],
})
