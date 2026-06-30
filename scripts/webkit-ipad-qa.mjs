#!/usr/bin/env node
// Interactive WebKit/iPad QA harness — drive the REAL app in a WebKit context
// with an iPad device profile so an agent can reproduce, measure, and verify
// iOS-class editor/layout bugs on the Mac without a physical device.
//
// Companion to scripts/webkit-qa.mjs (which probes bootstrap/storage). This one
// logs in, seeds editable content, and drives + MEASURES editor interactions.
//
// WHY a persistent, VISIBLE context (both matter):
//   - launchPersistentContext(dir): an ephemeral newContext() fails the local
//     SQLite (wa-sqlite/OPFS) open with UnknownError in WebKit. A real on-disk
//     profile makes OPFS/IndexedDB work — and a STABLE --profile keeps the
//     workspace + its plaintext mode-pin warm across runs (no e2ee re-gate).
//   - headless throttles rAF/rIC/IntersectionObserver, so idle-hydrated blocks
//     hang on "Loading…". Default is a visible window; --headless is smoke-only.
//
// WHAT IT CANNOT DO (use a real device / Simulator): reproduce iOS's NATIVE
// selection geometry. Desktop WebKit paints the native selection at the glyph
// box (~19px) and honors `::selection { transparent }`, so the drawn CodeMirror
// selection is all you see. On real iOS the native selection paints at the full
// line-height and ignores `transparent` — which is the root of the "grey above/
// below a multi-line selection" bug. The harness reproduces the SCENARIO and the
// drawn-vs-native geometry mismatch; the final on-device pixel still needs a
// device. See `--probe-selection`.
//
// LOCAL-ONLY BOOT: sets localStorage so Login renders straight to a logged-in
// local user (no Supabase round-trip), then clicks through the §6 e2ee
// "not encrypted" quarantine gate. No real data is touched — the profile gets
// its own deterministic local personal workspace.
//
// WORKTREE CAVEAT: a git worktree has no node_modules of its own (deps resolve
// up to the main checkout), which trips vite's server.fs.allow with 403s. Start
// the worktree's dev server with an fs.strict:false override config — see
// scripts/vite-qa.config.mjs — and point this harness at that port.
//
// Usage:
//   node scripts/webkit-ipad-qa.mjs [url] [--device="iPad Pro 11"]
//        [--profile=<dir>] [--seed] [--probe-selection] [--headless]
//        [--keep-open] [--out=scripts/.webkit-ipad-qa.png]
// Examples:
//   node scripts/webkit-ipad-qa.mjs http://localhost:5173 --seed --probe-selection
//   node scripts/webkit-ipad-qa.mjs http://localhost:5199 --probe-selection --keep-open

import { webkit, devices } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, fb) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : fb
}

const url = argv.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173'
const deviceName = opt('device', 'iPad Pro 11')
const headless = flag('headless')
const doSeed = flag('seed')
const doProbe = flag('probe-selection')
const keepOpen = flag('keep-open')
const outPath = opt('out', 'scripts/.webkit-ipad-qa.png')
// A stable profile keeps the workspace warm (no re-seed, no e2ee re-gate).
// Default to a fresh temp profile unless the caller pins one with --profile.
const profileDir = opt('profile', mkdtempSync(join(tmpdir(), 'webkit-ipad-qa-')))

const device = devices[deviceName]
if (!device) {
  console.error(`Unknown device "${deviceName}". iPad options:\n  ` +
    Object.keys(devices).filter((d) => /iPad/.test(d)).join('\n  '))
  process.exit(2)
}

const log = (tag, msg) => console.log(`[${tag}] ${msg}`)

const context = await webkit.launchPersistentContext(profileDir, { ...device, headless })
// Render straight to a logged-in local-only user — skips the Supabase login UI.
await context.addInitScript(() => {
  localStorage.setItem('ftm.user', JSON.stringify({ id: 'qa-bot', name: 'QA Bot' }))
  localStorage.setItem('ftm.localOnly', 'true')
})

const page = await context.newPage()
page.on('console', (m) => { if (m.type() === 'error') log('console.error', m.text().slice(0, 200)) })
page.on('pageerror', (e) => log('pageerror', `${e.name}: ${e.message}`))

log('start', `${deviceName} → ${url}${doSeed ? ' [seed]' : ''}${doProbe ? ' [probe]' : ''}`)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

// Click through the §6 e2ee quarantine gate if it appears.
const gateBtn = page.getByRole('button', { name: 'This workspace is not encrypted' })
try {
  await gateBtn.waitFor({ state: 'visible', timeout: 6000 })
  await gateBtn.click()
  log('gate', 'confirmed plaintext')
} catch { /* no gate — already pinned, or fresh boot pinned it inline */ }

await page.locator('.tm-block[data-block-id]').first().waitFor({ state: 'visible', timeout: 20_000 })
log('ready', 'outline rendered')

const LONG =
  'testing a long wrapping line ' +
  'rstartartarsarstartrstarstawtwaft'.repeat(5) + ' end of the line here'

// Seed a long wrapped-line block (only if the workspace has no editable content
// yet — a stable --profile keeps a prior seed).
const hasContent = await page.evaluate(
  () => (document.querySelector('.cm-content')?.textContent ?? '').length > 80,
)
if (doSeed && !hasContent) {
  await page.locator('.tm-block[data-block-id]').first().click()
  await page.waitForTimeout(300)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(LONG, { delay: 0 })
  await page.waitForTimeout(700)
  log('seed', 'inserted long wrapped-line block')
} else if (hasContent) {
  await page.locator('.cm-content').first().click()
  await page.waitForTimeout(300)
}

if (doProbe) {
  // Drive a multi-row selection through CodeMirror via the keyboard (Home, then
  // Shift+Down×2 + Shift+End) so CM's own drawn-selection layer updates — a raw
  // DOM-range selection wouldn't sync into CM state, leaving `.cm-selectionBackground`
  // stale. Then dump the CM drawn rects vs WebKit's native rects: a height/offset
  // mismatch here is what bleeds grey on real iOS.
  await page.locator('.cm-content').first().click()
  await page.waitForTimeout(150)
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
  await page.waitForTimeout(250)
  const geo = await page.evaluate(() => {
    const content = document.querySelector('.cm-content')
    if (!content) return { error: 'no .cm-content — is a block in edit mode?' }
    const sel = getSelection()
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null
    const rr = (b) => ({ top: +b.top.toFixed(2), bottom: +b.bottom.toFixed(2), h: +b.height.toFixed(2) })
    const drawn = [...document.querySelectorAll('.cm-selectionBackground')].map((e) => rr(e.getBoundingClientRect()))
    const native = range ? [...range.getClientRects()].map(rr) : []
    const cs = getComputedStyle(content)
    return {
      lineHeight: cs.lineHeight,
      drawnRects: drawn,
      nativeRects: native,
      // On real iOS the native rects are ~line-height tall and the difference
      // vs the drawn rects shows as grey. Desktop WebKit native rects are glyph-
      // tall, so this prints the mismatch but not the on-device grey.
      note: 'drawn vs native height/offset mismatch ⇒ grey bleed on iOS',
    }
  })
  log('selection-geometry', JSON.stringify(geo, null, 2))
}

await page.screenshot({ path: outPath }).catch(() => {})
log('screenshot', outPath)
log('profile', profileDir)

if (keepOpen) {
  log('keep-open', 'window left open — Ctrl+C to exit')
  await new Promise(() => {})
}
await context.close()
