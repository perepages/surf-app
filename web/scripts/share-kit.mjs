// Makes the share kit from src/lib/site.ts, using Chrome itself to draw (no image packages):
//   public/og.png                 1200x630  link preview (WhatsApp, Telegram, X, iMessage...)
//   share-kit/poster-a5.pdf       A5 poster with the QR code, ready to print
//   share-kit/poster-a5.png       the same poster as an image (to check it or send it)
//   share-kit/share-square.png    1080x1080 Instagram post / WhatsApp image
//   share-kit/share-story.png     1080x1920 Instagram / WhatsApp story
//   share-kit/qr-rate.svg|.png    the QR code alone (opens RATE_URL)
//
//   npm run share-kit       (CHROME_PATH overrides where Chrome is)
//
// Run it again after changing the address or the wording in src/lib/site.ts.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import QRCode from 'qrcode'
import { RATE_URL } from '../src/lib/site.ts'

const web = fileURLToPath(new URL('..', import.meta.url))
const out = join(web, 'share-kit')
mkdirSync(out, { recursive: true })

const CHROME =
  process.env.CHROME_PATH ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].find((p) => existsSync(p))
if (!CHROME) throw new Error('Chrome not found: set CHROME_PATH')

// App colours (src/index.css).
const C = {
  abyss: '#031b26', deep: '#072f3f', kelp: '#0f5257', water: '#0c4150', foam: '#e6f2ee',
  mist: '#8fb3bc', glass: '#5fe3c0', sand: '#f4c95d', s: ['#24434f', '#2f6f78', '#3fa79a', '#5fe3c0', '#c9ffec'],
}
const SHORT = RATE_URL.replace(/^https?:\/\//, '')
const HEADLINE = 'How were the waves today?'
const SUB = 'Rate them and help train a better forecast.'

const font = (file) => pathToFileURL(join(web, 'public', 'fonts', file)).href
const BASE_CSS = `
@font-face { font-family: 'Big Shoulders Display'; src: url('${font('big-shoulders-display-latin.woff2')}') format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Familjen Grotesk'; src: url('${font('familjen-grotesk-latin.woff2')}') format('woff2'); font-weight: 400 700; }
* { box-sizing: border-box; margin: 0; }
html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Familjen Grotesk', system-ui, sans-serif; }
.display { font-family: 'Big Shoulders Display', 'Arial Narrow', Impact, sans-serif; font-weight: 800; text-transform: uppercase; line-height: .9; letter-spacing: .005em; }
`

/** The app icon's breaking wave in a wide scene (viewBox 1200 x 420). No sky: the page colour shows through. */
const wave = () => `
<svg viewBox="0 0 1200 420" preserveAspectRatio="xMaxYMax slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M0 300 C180 268 340 276 500 300 C680 328 860 326 1000 290 C1080 270 1140 262 1200 266 L1200 420 L0 420 Z" fill="${C.kelp}"/>
  <path d="M0 360 C220 348 420 352 640 362 L1200 362 L1200 420 L0 420 Z" fill="${C.glass}" opacity=".35"/>
  <g transform="translate(688 -2)">
    <path d="M-688 372 L0 372 C140 372 182 330 200 268 C222 192 292 140 364 152 C424 162 456 214 436 262
             C422 296 378 302 360 276 C346 256 360 230 384 234 C372 212 334 208 308 234 C272 270 280 352 360 370
             L512 370 L512 422 L-688 422 Z" fill="${C.glass}"/>
  </g>
  <rect y="408" width="1200" height="12" fill="${C.water}"/>
</svg>`

/** The 1-5 score scale the app uses, as the "rate it" hint. */
const chips = (size) => `
<div style="display:flex; gap:${size * 0.18}px">
  ${C.s.map((bg, i) => `<div class="display" style="width:${size}px; height:${size}px; border-radius:${size * 0.22}px; background:${bg};
     color:${i >= 3 ? C.abyss : C.foam}; display:grid; place-items:center; font-size:${size * 0.62}px; line-height:1">${i + 1}</div>`).join('')}
</div>`

async function qrSvg(dark, light) {
  return QRCode.toString(RATE_URL, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark, light } })
}

function shot(html, file, width, height) {
  const dir = mkdtempSync(join(tmpdir(), 'surf-share-'))
  const page = join(dir, 'page.html')
  writeFileSync(page, html)
  const r = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=3000',
    `--window-size=${width},${height}`, `--screenshot=${file}`, pathToFileURL(page).href,
  ], { stdio: 'pipe' })
  rmSync(dir, { recursive: true, force: true })
  if (!existsSync(file)) throw new Error(`Chrome made no ${file}: ${r.stderr}`)
}

function pdf(html, file) {
  const dir = mkdtempSync(join(tmpdir(), 'surf-share-'))
  const page = join(dir, 'page.html')
  writeFileSync(page, html)
  rmSync(file, { force: true })
  const r = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${join(dir, 'profile')}`,
    '--virtual-time-budget=3000', `--print-to-pdf=${file}`, pathToFileURL(page).href,
  ], { stdio: 'pipe' })
  rmSync(dir, { recursive: true, force: true })
  if (!existsSync(file)) throw new Error(`Chrome made no ${file}: ${r.stderr}`)
}

const doc = (css, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`

// ---------- Link preview 1200x630 (no QR: it's shown small, and the link is the tap target) ----------
function ogHtml() {
  return doc(`
    body { width:1200px; height:630px; overflow:hidden; background:${C.abyss}; color:${C.foam}; position:relative; }
    .sea { position:absolute; left:0; right:0; bottom:0; height:250px; }
    .sea svg { width:100%; height:100%; display:block; }
    .text { position:absolute; left:72px; top:56px; right:72px; }
    .brand { font-size:26px; letter-spacing:.14em; color:${C.glass}; margin-bottom:20px; }
    h1 { font-size:104px; max-width:720px; }
    p { margin-top:22px; font-size:34px; color:${C.mist}; max-width:640px; line-height:1.2; }
    .chips { position:absolute; right:72px; top:72px; }
  `, `
    <div class="text">
      <div class="display brand">Vilanova Surf</div>
      <h1 class="display">${HEADLINE}</h1>
      <p>${SUB}</p>
    </div>
    <div class="chips">${chips(44)}</div>
    <div class="sea">${wave()}</div>`)
}

// ---------- Square 1080x1080 and story 1080x1920 ----------
function socialHtml(width, height, qr) {
  const story = height > width
  return doc(`
    body { width:${width}px; height:${height}px; overflow:hidden; background:${C.abyss}; color:${C.foam}; position:relative;
           display:flex; flex-direction:column; padding:${story ? '150px 84px 0' : '84px 84px 0'}; }
    body > * { flex:none; }
    .brand { font-size:${story ? 40 : 32}px; letter-spacing:.14em; color:${C.glass}; }
    h1 { font-size:${story ? 190 : 140}px; margin-top:${story ? 56 : 36}px; }
    p { margin-top:${story ? 44 : 30}px; font-size:${story ? 54 : 42}px; color:${C.mist}; line-height:1.2; max-width:${story ? 880 : 860}px; }
    .chips { margin-top:${story ? 60 : 40}px; }
    .cta { margin-top:${story ? 90 : 0}px; display:flex; align-items:center; gap:36px; ${story ? '' : 'position:absolute; right:84px; bottom:300px;'} }
    .qr { flex:none; background:#fff; padding:${story ? 26 : 18}px; border-radius:24px; width:${story ? 300 : 210}px; height:${story ? 300 : 210}px; }
    .qr svg { width:100%; height:100%; display:block; }
    .url { font-size:${story ? 46 : 34}px; font-weight:700; color:${C.foam}; }
    .url small { display:block; font-size:.62em; font-weight:400; color:${C.mist}; margin-bottom:8px; }
    .sea { position:absolute; left:0; right:0; bottom:0; height:${story ? 520 : 300}px; }
    .sea svg { width:100%; height:100%; display:block; }
  `, `
    <div class="display brand">Vilanova Surf</div>
    <h1 class="display">${HEADLINE}</h1>
    <p>${SUB}</p>
    <div class="chips">${chips(story ? 92 : 72)}</div>
    ${story ? `<div class="cta"><div class="qr">${qr}</div><div class="url"><small>Rate in 3 taps</small>${SHORT}</div></div>` : `<div class="url" style="margin-top:44px"><small>Rate in 3 taps</small>${SHORT}</div>`}
    <div class="sea">${wave()}</div>`)
}

// ---------- A5 poster (148 x 210 mm). White paper; dark ink only in the wave panel. ----------
function posterHtml(qr) {
  return doc(`
    @page { size: 148mm 210mm; margin: 0; }
    html, body { width:148mm; height:210mm; }
    body { background:#fff; color:${C.abyss}; padding:9mm; display:flex; flex-direction:column; overflow:hidden; }
    .panel { border-radius:5mm; overflow:hidden; background:${C.abyss}; color:${C.foam}; position:relative; height:90mm; flex:none; }
    .panel .sea { position:absolute; left:0; right:0; bottom:0; height:30mm; }
    .panel .sea svg { width:100%; height:100%; display:block; }
    .panel .text { position:absolute; left:7mm; right:7mm; top:7mm; }
    .brand { font-size:4.2mm; letter-spacing:.14em; color:${C.glass}; }
    h1 { font-size:17.5mm; margin-top:3mm; }
    .sub { margin-top:9mm; font-size:6.2mm; font-weight:700; line-height:1.15; color:${C.abyss}; }
    .row { margin-top:9mm; display:flex; gap:7mm; align-items:center; }
    .qr { width:60mm; height:60mm; flex:none; }
    .qr svg { width:100%; height:100%; display:block; }
    .steps { font-size:4.1mm; line-height:1.35; }
    .steps b { display:block; font-size:5mm; margin-bottom:2mm; }
    .steps ol { padding-left:5mm; }
    .steps .url { margin-top:3mm; font-weight:700; font-size:3.9mm; word-break:break-all; }
    .chips { margin-top:3mm; }
    footer { margin-top:auto; display:flex; justify-content:space-between; font-size:2.8mm; color:#3d5560; }
  `, `
    <div class="panel">
      <div class="text">
        <div class="display brand">Vilanova Surf · Platja de Vilanova</div>
        <h1 class="display">${HEADLINE}</h1>
      </div>
      <div class="sea">${wave()}</div>
    </div>
    <p class="sub">${SUB}</p>
    <div class="row">
      <div class="qr">${qr}</div>
      <div class="steps">
        <b>Scan with your phone camera</b>
        <ol><li>Pick when you surfed</li><li>Give it 1 to 5</li><li>Send</li></ol>
        <div class="chips">${chips(28)}</div>
        <div class="url">${SHORT}</div>
      </div>
    </div>
    <footer><span>Every rating teaches the forecast what "good" means here.</span><span>Weather data by Open-Meteo.com</span></footer>`)
}

const qrDark = await qrSvg(C.abyss, '#ffffff')
writeFileSync(join(out, 'qr-rate.svg'), qrDark)
await QRCode.toFile(join(out, 'qr-rate.png'), RATE_URL, { errorCorrectionLevel: 'M', margin: 4, width: 1200, color: { dark: C.abyss, light: '#ffffff' } })

shot(ogHtml(), join(web, 'public', 'og.png'), 1200, 630)
shot(socialHtml(1080, 1080, qrDark), join(out, 'share-square.png'), 1080, 1080)
shot(socialHtml(1080, 1920, qrDark), join(out, 'share-story.png'), 1080, 1920)
const poster = posterHtml(qrDark)
pdf(poster, join(out, 'poster-a5.pdf'))
// 148 x 210 mm at 96 px/in = 559 x 794 px; the PNG copy is drawn at 3x (about 200 dpi).
shot(poster.replace('<style>', '<style>html{zoom:3}'), join(out, 'poster-a5.png'), 1677, 2382)

console.log(`Share kit for ${RATE_URL}:\n  public/og.png\n  share-kit/poster-a5.pdf, poster-a5.png, share-square.png, share-story.png, qr-rate.svg, qr-rate.png`)
