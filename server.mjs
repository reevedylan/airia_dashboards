#!/usr/bin/env node
/**
 * Serves the built dashboard and forwards its API calls.
 *
 * Both halves are necessary. The Airia API sends no
 * Access-Control-Allow-Origin header, so a browser cannot call it directly
 * however valid the key — the page has to call its own origin and have
 * something here pass the request on. In development Vite's proxy does this;
 * this file is the same thing for `npm start`.
 *
 *   npm run build && npm start        # then open http://localhost:4173
 *
 * It is deliberately a LOCAL tool. Do not host it for other people: every
 * request carries the caller's API key, so whoever runs the proxy sees it.
 * Each tenant should run their own copy and paste their own key.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyAiria } from './proxy.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 4173)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}

async function serveStatic(req, res) {
  // Normalise before joining so a request cannot escape dist/.
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, rel)
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(DIST, 'index.html')        // SPA fallback
  }
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found. Run `npm run build` first.')
  }
}

createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
  if (req.url.startsWith('/airia/')) return proxyAiria(req, res)
  return serveStatic(req, res)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Gateway usage dashboard → http://localhost:${PORT}`)
  console.log('  proxying /airia → the Airia environment chosen on the key page')
  console.log('  bound to 127.0.0.1 only: this forwards whatever key the page sends,')
  console.log('  so it is a local tool, not something to host for others.')
})
