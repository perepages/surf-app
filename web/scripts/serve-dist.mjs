// Serves web/dist like a real host (Vercel/Netlify): brotli/gzip compression, long-lived
// caching for hashed assets, no caching for index.html and sw.js, and index.html for unknown
// paths. Node only, no packages. Used for Lighthouse runs and offline tests.
// /api/forecast runs the real Vercel function (api/forecast.ts, Node 23.6+ runs .ts directly)
// with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the repo-root .env (never sent anywhere else).
//
//   node scripts/serve-dist.mjs [port]      (default 4173)

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'

// DIST_DIR: serve another build folder (used for A/B performance checks).
const root = process.env.DIST_DIR ?? fileURLToPath(new URL('../dist/', import.meta.url))
const port = Number(process.argv[2] ?? 4173)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt'])
const cache = new Map()

/** KEY=value lines of the repo-root .env (missing file = nothing). */
async function rootEnv() {
  const text = await readFile(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8').catch(() => '')
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
const env = { ...(await rootEnv()), ...process.env }
const { handleForecast } = await import('../api/forecast.ts')

async function load(path) {
  if (cache.has(path)) return cache.get(path)
  const body = await readFile(path)
  const ext = extname(path)
  const entry = {
    body,
    br: COMPRESSIBLE.has(ext) ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) : null,
    gz: COMPRESSIBLE.has(ext) ? gzipSync(body, { level: 9 }) : null,
  }
  cache.set(path, entry)
  return entry
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/forecast') {
      const response = await handleForecast(new Request(url, { method: req.method }), env)
      const body = Buffer.from(await response.arrayBuffer())
      const headers = Object.fromEntries(response.headers)
      const accept = String(req.headers['accept-encoding'] ?? '')
      let out = body
      if (body.length && accept.includes('br')) {
        out = brotliCompressSync(body)
        headers['content-encoding'] = 'br'
      }
      res.writeHead(response.status, { ...headers, 'content-length': out.length })
      res.end(req.method === 'HEAD' ? undefined : out)
      return
    }
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    if (rel.includes('..')) throw Object.assign(new Error('bad path'), { code: 400 })
    let file = join(root, rel || 'index.html')
    const isFile = await stat(file).then((s) => s.isFile()).catch(() => false)
    if (!isFile) {
      if (extname(rel)) {
        res.writeHead(404).end('Not found')
        return
      }
      rel = 'index.html'
      file = join(root, rel)
    }
    const ext = extname(file)
    const { body, br, gz } = await load(file)
    const accept = String(req.headers['accept-encoding'] ?? '')
    const headers = {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': rel.startsWith('assets/') || rel.startsWith('fonts/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      Vary: 'Accept-Encoding',
    }
    let out = body
    if (br && accept.includes('br')) {
      headers['Content-Encoding'] = 'br'
      out = br
    } else if (gz && accept.includes('gzip')) {
      headers['Content-Encoding'] = 'gzip'
      out = gz
    }
    res.writeHead(200, { ...headers, 'Content-Length': out.length })
    res.end(req.method === 'HEAD' ? undefined : out)
  } catch (err) {
    res.writeHead(err.code === 400 ? 400 : 500).end(String(err.message))
  }
}).listen(port, () => console.log(`Serving web/dist on http://localhost:${port}`))
