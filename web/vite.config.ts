import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { CACHE_TTL_MS, FETCHED_AT_KEY, primaryRequestUrls } from './src/lib/forecastRequest.ts'
import { DEFAULT_SPOT_ID, FALLBACK_SPOTS } from './src/lib/spots.config.ts'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * Writes dist/sw.js from sw/sw.template.js after a build: fills in every built file to
 * precache and a version hash of their contents, so each deploy gets a fresh cache.
 * (Done by hand instead of a PWA plugin: it's ~30 lines and needs no new dependency.)
 */
function serviceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'surf-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const root = join(process.cwd(), outDir)

      // Put the stylesheet straight into index.html (about 6 KB compressed). As a separate file it
      // blocks the first paint and, on a slow connection, shares bandwidth with the JavaScript.
      const html = join(root, 'index.html')
      const page = readFileSync(html, 'utf8')
      const link = page.match(/<link rel="stylesheet"[^>]*href="\/(assets\/[^"]+\.css)"[^>]*>/)
      if (link) {
        const css = readFileSync(join(root, link[1]), 'utf8')
        const usedElsewhere = readdirSync(join(root, 'assets')).some(
          (f) => f.endsWith('.js') && readFileSync(join(root, 'assets', f), 'utf8').includes(link[1]),
        )
        writeFileSync(html, page.replace(link[0], () => `<style>${css}</style>`))
        if (!usedElsewhere) rmSync(join(root, link[1]))
      }

      const files: string[] = []
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else files.push(relative(root, full).split(sep).join('/'))
        }
      }
      walk(root)
      const precache = files.filter((f) => f !== 'sw.js').sort()
      const hash = createHash('sha256')
      for (const f of precache) hash.update(f).update(readFileSync(join(root, f)))
      const sw = readFileSync(new URL('./sw/sw.template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', `${version}-${hash.digest('hex').slice(0, 10)}`)
        .replace('__PRECACHE__', JSON.stringify(precache.map((f) => `/${f}`)))
      writeFileSync(join(root, 'sw.js'), sw)
    },
  }
}

/**
 * Adds a tiny inline script to index.html that starts the two Open-Meteo requests at once,
 * in parallel with the app's JavaScript, unless the saved forecast is still fresh. The app
 * picks the responses up by URL (openMeteo.ts takePrefetched). Coordinates come from the last
 * spot saved on the phone, else the built-in copy.
 */
function prefetchForecast(): Plugin {
  const fallback = FALLBACK_SPOTS[DEFAULT_SPOT_ID]
  const templates = primaryRequestUrls({ lat: '__LAT__', lon: '__LON__' })
  const script = `(function(){try{
var t=+localStorage.getItem(${JSON.stringify(FETCHED_AT_KEY)});if(t&&Date.now()-t<${CACHE_TTL_MS})return;
var s=JSON.parse(localStorage.getItem(${JSON.stringify(`surf:last:spot:${DEFAULT_SPOT_ID}`)})||'null')||${JSON.stringify({ lat: fallback.lat, lon: fallback.lon })};
var p=window.__surfPrefetch={};
requestAnimationFrame(function(){setTimeout(function(){if(p.__started)return;
${JSON.stringify(templates)}.forEach(function(u){u=u.replace('__LAT__',s.lat).replace('__LON__',s.lon);p[u]=fetch(u).catch(function(){return null})});
},0)});
}catch(e){}})()`
  // The requests start one frame after the first paint: just as early in practice (the app's
  // JavaScript takes far longer to arrive), and they don't count against the first paint.
  return {
    name: 'surf-prefetch-forecast',
    transformIndexHtml: () => [{ tag: 'script', children: script, injectTo: 'head-prepend' }],
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), prefetchForecast(), serviceWorker()],
  // Read .env from the repo root so there is one .env for web/ and jobs/.
  envDir: '..',
  // Sent with each rating so training can tell app versions apart.
  define: { __APP_VERSION__: JSON.stringify(version) },
})
