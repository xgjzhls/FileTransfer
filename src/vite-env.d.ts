/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 信令服务 WebSocket URL（T03）。
   * 形如：wss://localtransfer-signaling.<subdomain>.workers.dev/ws
   * 部署后填入根目录 .env（模板见 .env.example）；T04 起前端使用。
   */
  readonly VITE_SIGNALING_WSS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
