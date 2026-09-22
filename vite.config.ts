import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The Airia API sends no Access-Control-Allow-Origin header, so the browser
 * cannot call it directly — a pasted key has to be forwarded by something on
 * the page's own origin. In dev that is this proxy; in production it is
 * `server.mjs`. The key travels in the request header and is never stored
 * here.
 */
const AIRIA_PROXY = {
  target: 'https://prodaus.api.airia.ai',
  changeOrigin: true,
  secure: true,
  rewrite: (path: string) => path.replace(/^\/airia/, ''),
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/airia': AIRIA_PROXY } },
  preview: { port: 4173, proxy: { '/airia': AIRIA_PROXY } },
})
