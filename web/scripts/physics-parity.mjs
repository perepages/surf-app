// Checks web/src/scoring/physics.ts against jobs/physics.py on random cases.
//   npm run physics-parity            (from web/; needs Python on PATH, nothing else)
// Python writes cases + its results (jobs/physics_cases.py); this compiles physics.ts with the
// project's TypeScript into a temp folder, runs every case and lists any difference.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const web = resolve(import.meta.dirname, '..')
const root = resolve(web, '..')
const n = process.argv[2] ?? '400'
const python = process.platform === 'win32' ? 'python' : 'python3'

const cases = JSON.parse(execFileSync(python, ['-m', 'jobs.physics_cases', n], { cwd: root, maxBuffer: 1 << 28 }).toString())

const out = mkdtempSync(join(tmpdir(), 'physics-parity-'))
try {
  const tsc = join(web, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [tsc, join(web, 'src', 'scoring', 'physics.ts'), '--outDir', out, '--module', 'es2022',
    '--target', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck', '--noCheck', '--rootDir', join(web, 'src')], { stdio: 'inherit', cwd: out })
  writeFileSync(join(out, 'package.json'), '{"type":"module"}')
  const physics = await import(pathToFileURL(join(out, 'scoring', 'physics.js')).href)

  const fill = (h) => ({ waveHeight: null, wavePeriod: null, waveDirection: null, tide: null, isDay: true, ...h })
  // Same text, the app uses typographic apostrophes.
  const norm = (s) => (s == null ? s : s.replaceAll('’', "'"))
  let bad = 0
  for (const [i, c] of cases.entries()) {
    const hour = fill(c.hour)
    const series = physics.seriesOf([...c.history.map(fill), hour])
    const r = physics.evaluate(hour, c.spot, series, c.daylight, c.prefs)
    const e = c.expect
    const diffs = []
    for (const k of ['waves', 'shape', 'overall', 'comfort', 'verdict']) if (Math.abs(r[k] - e[k]) > 0.011) diffs.push(`${k} ${r[k]} vs ${e[k]}`)
    for (const k of ['reason', 'mess', 'wetsuit']) if (norm(r[k]) !== norm(e[k])) diffs.push(`${k}\n      ts: ${r[k]}\n      py: ${e[k]}`)
    const kinds = r.warnings.map((w) => w.kind).join(',')
    if (kinds !== e.warnings.join(',')) diffs.push(`warnings ${kinds} vs ${e.warnings.join(',')}`)
    if (diffs.length) {
      bad++
      if (bad <= 10) console.log(`case ${i}:\n    ${diffs.join('\n    ')}`)
    }
  }
  console.log(bad ? `${bad} of ${cases.length} cases differ` : `All ${cases.length} cases match jobs/physics.py`)
  process.exitCode = bad ? 1 : 0
} finally {
  rmSync(out, { recursive: true, force: true })
}
