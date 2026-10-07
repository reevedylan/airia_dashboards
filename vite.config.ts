import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { proxyAiria } from './proxy.mjs'

/**
 * The Airia API sends no Access-Control-Allow-Origin header, so the browser
 * cannot call it directly — a pasted key has to be forwarded by something on
 * the page's own origin. In dev and preview that is this middleware; in
 * production it is `server.mjs`. Both run the SAME `proxy.mjs`, which picks
 * the upstream environment per request from `x-airia-host` — something
 * Vite's static `proxy.target` cannot do.
 */
const airia: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url?.startsWith('/airia/')) void proxyAiria(req, res)
  else next()
}

const airiaProxy = (): Plugin => ({
  name: 'airia-proxy',
  configureServer: (server) => { server.middlewares.use(airia) },
  configurePreviewServer: (server) => { server.middlewares.use(airia) },
})

export default defineConfig({
  plugins: [react(), airiaProxy()],
  server: { port: 5173 },
  preview: { port: 4173 },
})
