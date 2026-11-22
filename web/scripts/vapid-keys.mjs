// Makes the VAPID key pair for surf alerts (web push) and writes it into the repo-root .env.
// Node's built-in crypto only (no packages). Run once:  npm run vapid-keys
//
//   VITE_VAPID_PUBLIC_KEY  public: the app gives it to the browser when subscribing.
//                          Also set it in Vercel (Production + Preview), then redeploy.
//   VAPID_PRIVATE_KEY      SECRET: signs every push. GitHub Actions secret only. Never in Vercel,
//                          never in a VITE_* variable, never committed. Not printed here.
//   VAPID_SUBJECT          contact the push services can reach (the site address).
//
// Refuses to replace existing keys: a new pair silently breaks every alert already turned on
// (phones subscribed with the old public key). Use --force only if the private key leaked;
// everyone then has to turn their alert on again.

import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env')
const SUBJECT = 'https://isitworthsurf.vercel.app'
const force = process.argv.includes('--force')

let text = existsSync(ENV) ? readFileSync(ENV, 'utf8') : ''
const has = (name) => new RegExp(`^${name}=.+`, 'm').test(text)
if ((has('VAPID_PRIVATE_KEY') || has('VITE_VAPID_PUBLIC_KEY')) && !force) {
  console.log('VAPID keys are already in .env; nothing changed.')
  console.log('Replacing them breaks every alert already turned on. If you really must: npm run vapid-keys -- --force')
  process.exit(0)
}

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pub = publicKey.export({ format: 'jwk' })
const priv = privateKey.export({ format: 'jwk' })
const b64 = (s) => Buffer.from(s, 'base64url')
// Public key = uncompressed P-256 point (0x04 || x || y), base64url: what PushManager expects.
const publicRaw = Buffer.concat([Buffer.from([4]), b64(pub.x), b64(pub.y)]).toString('base64url')
// Private key = the raw 32-byte scalar, base64url: what pywebpush (py-vapid from_string) reads.
const privateRaw = b64(priv.d).toString('base64url')
if (b64(publicRaw).length !== 65 || b64(privateRaw).length !== 32) throw new Error('unexpected key size')

const set = (name, value) => {
  const line = `${name}=${value}`
  const re = new RegExp(`^${name}=.*$`, 'm')
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`
}
if (!/^# Surf alerts/m.test(text)) text = `${text.replace(/\n*$/, '\n')}\n# Surf alerts (web push), made by npm run vapid-keys\n`
set('VITE_VAPID_PUBLIC_KEY', publicRaw)
set('VAPID_PRIVATE_KEY', privateRaw)
set('VAPID_SUBJECT', SUBJECT)
writeFileSync(ENV, text)

console.log(`Written to ${ENV}:`)
console.log(`  VITE_VAPID_PUBLIC_KEY=${publicRaw}`)
console.log('  VAPID_PRIVATE_KEY=(hidden: copy it from .env into a GitHub Actions secret)')
console.log(`  VAPID_SUBJECT=${SUBJECT}`)
