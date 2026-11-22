// Measures the built app like a phone would see it, using Chrome directly (no packages):
//   1. first visit (empty phone), 2. repeat visit (service worker + saved data),
//   3. offline start, 4. Chrome's own "is this installable?" check.
// Network and CPU are throttled with Chrome's real emulation, so service-worker hits stay fast,
// unlike Lighthouse's default simulation.
//
//   npm run build && npm run serve:dist          (in one terminal)
//   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run measure
//
// Profiles: "slow4g" = Lighthouse's mobile setting (1.6 Mbit/s, 150 ms RTT); "4g" = a typical
// 4G connection (9 Mbit/s, 70 ms RTT). Both with a 4x slower CPU, like a mid-range phone.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_TO_TEST = process.env.URL ?? 'http://localhost:4173/'
const CHROME = process.env.CHROME_PATH
if (!CHROME) throw new Error('Set CHROME_PATH to your Chrome executable')

const PROFILES = {
  slow4g: { latency: 150 * 3.75, down: (1638.4 * 0.9 * 1024) / 8, up: (750 * 0.9 * 1024) / 8 },
  '4g': { latency: 70, down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8 },
}
const PORT = 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startChrome(profileDir) {
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return { proc, ws: page.webSocketDebuggerUrl }
    } catch { /* not up yet */ }
    await sleep(200)
  }
  throw new Error('Chrome did not start')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const listeners = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method) listeners.get(msg.method)?.forEach((f) => f(msg.params))
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const once = (method) => new Promise((r) => listeners.set(method, [...(listeners.get(method) ?? []), r]))
  return new Promise((r) => (ws.onopen = () => r({ send, once, close: () => ws.close() })))
}

const COLLECT = `
  window.__lcp = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime })
    .observe({ type: 'largest-contentful-paint', buffered: true });`

async function visit(cdp, { offline = false, profile } = {}) {
  const p = PROFILES[profile]
  await cdp.send('Network.emulateNetworkConditions', {
    offline, latency: offline ? 0 : p.latency, downloadThroughput: offline ? 0 : p.down, uploadThroughput: offline ? 0 : p.up,
  })
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: URL_TO_TEST })
  await loaded
  // Wait for the forecast to be on screen, up to 20 s: on the home screen the first spot row,
  // on a spot's page the verdict word (its only h1).
  const SHOWN = `location.pathname.startsWith('/spot/') ? (document.querySelector('h1')?.textContent ?? null) : (document.querySelector('main li a[href^="/spot/"]')?.textContent ?? null)`
  let shown = null
  for (let i = 0; i < 100 && !shown; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: SHOWN, returnByValue: true })
    shown = r.result.value
    if (!shown) await sleep(200)
  }
  await sleep(1500) // let LCP settle
  const r = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `({
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      lcp: window.__lcp,
      verdict: ${SHOWN},
      offlineNotice: document.body.innerText.includes('offline'),
      swControlled: !!navigator.serviceWorker.controller,
    })`,
  })
  return r.result.value
}

async function run(profile) {
  const dir = mkdtempSync(join(tmpdir(), 'surf-measure-'))
  const { proc, ws } = await startChrome(dir)
  try {
    const cdp = await connect(ws)
    await cdp.send('Page.enable')
    await cdp.send('Network.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECT })

    // Warm Chrome itself up first (its own start-up work would otherwise land on the first visit).
    const warm = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: 'data:text/html,<p>warm-up</p>' })
    await warm
    await sleep(1000)

    const first = await visit(cdp, { profile })
    // Let the service worker finish caching the app before the next visit.
    for (let i = 0; i < 50; i++) {
      const r = await cdp.send('Runtime.evaluate', {
        awaitPromise: true, returnByValue: true,
        expression: `(async () => { const k = await caches.keys(); if (!k.length) return 0; const c = await caches.open(k[0]); return (await c.keys()).length })()`,
      })
      if (r.result.value > 5) break
      await sleep(300)
    }
    const repeat = await visit(cdp, { profile })
    const offline = await visit(cdp, { profile, offline: true })

    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: URL_TO_TEST })
    await loaded
    await sleep(1000)
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
    const manifest = await cdp.send('Page.getAppManifest')
    cdp.close()
    return { first, repeat, offline, installErrors: installabilityErrors ?? [], manifestErrors: manifest.errors ?? [] }
  } finally {
    proc.kill()
    await sleep(500)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Chrome may still hold files */ }
  }
}

const ms = (x) => (x == null ? '–' : `${(x / 1000).toFixed(2)} s`)
for (const profile of Object.keys(PROFILES)) {
  const r = await run(profile)
  console.log(`\n== ${profile} (4x CPU) ==`)
  console.log(`first visit : FCP ${ms(r.first.fcp)}  LCP ${ms(r.first.lcp)}  verdict "${r.first.verdict}"`)
  console.log(`repeat visit: FCP ${ms(r.repeat.fcp)}  LCP ${ms(r.repeat.lcp)}  service worker: ${r.repeat.swControlled}`)
  console.log(`offline     : verdict "${r.offline.verdict}"  offline notice: ${r.offline.offlineNotice}  service worker: ${r.offline.swControlled}`)
  console.log(`installable : ${r.installErrors.length ? JSON.stringify(r.installErrors) : 'yes'}  manifest errors: ${r.manifestErrors.length ? JSON.stringify(r.manifestErrors) : 'none'}`)
}
