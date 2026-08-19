#!/usr/bin/env node
// WebKit QA harness — reproduce iOS-class bugs on the Mac.
//
// On iOS, EVERY browser (Chrome, Safari, …) is WebKit/WKWebView, so the engine
// that ships to iPhone/iPad is the same family Playwright drives here. This lets
// us iterate on WebKit-specific layout/JS/storage bugs without a device.
//
// Caveats (what this CANNOT reproduce — use a real device / Simulator for these):
//   - the iOS WebContent memory cap (OOM / jetsam) — desktop WebKit has GBs
//   - iOS Chrome/Safari's collapsing address bar changing innerHeight/visualViewport
//   - the on-screen keyboard resizing the viewport
// What it CAN: WebKit CSS/layout/JS-engine quirks, touch, Service Worker, and the
// private-mode OPFS/IndexedDB unavailability class (via --no-opfs / --no-idb).
//
// Per the project's hard-won QA lesson, default to a VISIBLE window: a hidden tab
// is visibilityState:hidden → rAF/rIC/IntersectionObserver get throttled and
// interaction/idle-hydration bugs vanish. Pass --headless only for smoke checks.
//
// Usage:
//   node scripts/webkit-qa.mjs <url> [--device="iPhone 14 Pro"] [--no-opfs]
//                                     [--no-idb] [--headless] [--wait=8000]
//                                     [--out=screenshot.png]
// Examples:
//   node scripts/webkit-qa.mjs https://app.example.com
//   node scripts/webkit-qa.mjs http://localhost:5173 --no-opfs   # repro iOS private-mode crash
//   node scripts/webkit-qa.mjs http://localhost:5173 --device="iPad Pro 11"

import { webkit, devices } from 'playwright'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const url = argv.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173'
const deviceName = opt('device', 'iPhone 14 Pro')
const headless = flag('headless')
const noOpfs = flag('no-opfs')
const noIdb = flag('no-idb')
const waitMs = Number(opt('wait', '8000'))
const outPath = opt('out', `scripts/.webkit-qa.${Date.now()}.png`)

const device = devices[deviceName]
if (!device) {
  console.error(`Unknown device "${deviceName}". Some options:\n  ` +
    Object.keys(devices).filter((d) => /iPhone|iPad/.test(d)).join('\n  '))
  process.exit(2)
}

// Simulates iOS private/incognito browsing, where WebKit blocks persistent
// storage. getDirectory() throws SecurityError; indexedDB.open is nulled out.
const KILL_OPFS = `
  if (navigator.storage) {
    navigator.storage.getDirectory = () =>
      Promise.reject(new DOMException('OPFS blocked (simulated private mode)', 'SecurityError'))
  }
`
const KILL_IDB = `
  Object.defineProperty(window, 'indexedDB', { value: null, configurable: true })
`

const log = (tag, msg) => console.log(`[${tag}] ${msg}`)

const browser = await webkit.launch({ headless })
const context = await browser.newContext({ ...device })
if (noOpfs) await context.addInitScript(KILL_OPFS)
if (noIdb) await context.addInitScript(KILL_IDB)

const page = await context.newPage()

// Capture everything that signals a bootstrap failure.
page.on('console', (m) => log(`console.${m.type()}`, m.text()))
page.on('pageerror', (e) => log('pageerror', `${e.name}: ${e.message}\n${e.stack ?? ''}`))
page.on('requestfailed', (r) =>
  log('requestfailed', `${r.failure()?.errorText ?? '?'} ${r.url()}`))
page.on('crash', () => log('crash', 'PAGE CRASHED (WebContent process died)'))

log('start', `${deviceName} → ${url}` +
  `${noOpfs ? ' [no-opfs]' : ''}${noIdb ? ' [no-idb]' : ''}${headless ? ' [headless]' : ''}`)

let navError = null
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
} catch (e) {
  navError = e
  log('nav-error', e.message)
}

// Let async bootstrap (DB init, sync, hydration) run, then snapshot reality.
await page.waitForTimeout(waitMs)

const probe = await page.evaluate(async () => {
  // Effective OPFS availability: in iOS private mode getDirectory() EXISTS but
  // rejects with SecurityError, so a typeof check lies — actually invoke it.
  let opfs = false
  let opfsError = null
  try {
    await navigator.storage.getDirectory()
    opfs = true
  } catch (e) {
    opfsError = `${e.name}: ${e.message}`
  }
  return {
    opfs,
    opfsError,
    idb: !!window.indexedDB,
    sab: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: self.crossOriginIsolated,
    sharedWorker: typeof SharedWorker !== 'undefined',
    // What is the user actually staring at?
    bodyText: (document.body?.innerText ?? '').trim().slice(0, 200),
    title: document.title,
  }
}).catch((e) => ({ evalError: String(e) }))

log('probe', JSON.stringify(probe, null, 2))
await page.screenshot({ path: outPath, fullPage: false }).catch(() => {})
log('screenshot', outPath)

await browser.close()
process.exit(navError ? 1 : 0)
