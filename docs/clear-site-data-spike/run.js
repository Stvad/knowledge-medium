// Clear-Site-Data spike: does a service-worker-SYNTHESIZED Clear-Site-Data
// response actually clear storage in Chromium? Contrasts SW-synthesized (A1),
// SW pass-through of a network response (A2), plain network fetch (B), and
// top-level navigation (C). Fully isolated: ephemeral Playwright contexts +
// temp user-data-dir. localhost is a secure context, so SW + Clear-Site-Data
// both work over plain HTTP.
const http = require('http')
const { chromium } = require('playwright-core')

const CSD = '"cache", "cookies", "storage"'

const SW_JS = `
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.pathname === '/sw-clear') {
    // A1: fully synthesized response carrying the header
    e.respondWith(new Response('sw-synth-clear', {
      status: 200,
      headers: { 'Clear-Site-Data': ${JSON.stringify(CSD)}, 'Content-Type': 'text/plain' },
    }))
    return
  }
  if (url.pathname === '/sw-passthrough') {
    // A2: pass through a real network response that carries the header
    e.respondWith(fetch('/network-clear'))
    return
  }
  // everything else: default network
})
`

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>csd-spike</title></head><body>csd-spike</body></html>`

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Service-Worker-Allowed': '/' })
      res.end(SW_JS)
      return
    }
    if (url.pathname === '/network-clear') {
      // B/A2/C: a REAL network response carrying the header
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Clear-Site-Data': CSD })
      res.end('network-clear')
      return
    }
    if (url.pathname === '/cached') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('cached')
      return
    }
    // '/', '/after-nav', anything else -> the page
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(PAGE_HTML)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// ---- in-page helpers (run via page.evaluate) ----
const seedFn = async () => {
  localStorage.setItem('csd-ls', 'v')
  sessionStorage.setItem('csd-ss', 'v')
  document.cookie = 'csdck=1; path=/'
  await new Promise((res, rej) => {
    const r = indexedDB.open('csd-db', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('s')
    r.onsuccess = () => {
      const db = r.result
      const tx = db.transaction('s', 'readwrite')
      tx.objectStore('s').put('v', 'k')
      tx.oncomplete = () => { db.close(); res() }
      tx.onerror = () => rej(tx.error)
    }
    r.onerror = () => rej(r.error)
  })
  const c = await caches.open('csd-cache')
  await c.put('/cached', new Response('x'))
  let opfs = false
  try {
    const root = await navigator.storage.getDirectory()
    const fh = await root.getFileHandle('csd.txt', { create: true })
    const w = await fh.createWritable()
    await w.write('v')
    await w.close()
    opfs = true
  } catch (e) { opfs = 'ERR:' + e.name }
  return { opfsSeeded: opfs }
}

const inventoryFn = async () => {
  const out = {}
  out.localStorage = localStorage.getItem('csd-ls') !== null
  out.sessionStorage = sessionStorage.getItem('csd-ss') !== null
  out.cookie = document.cookie.includes('csdck=1')
  try {
    const dbs = await indexedDB.databases()
    out.indexedDB = dbs.some((d) => d.name === 'csd-db')
  } catch (e) { out.indexedDB = 'ERR:' + e.name }
  try { out.cacheStorage = await caches.has('csd-cache') } catch (e) { out.cacheStorage = 'ERR:' + e.name }
  try {
    const root = await navigator.storage.getDirectory()
    await root.getFileHandle('csd.txt', { create: false })
    out.opfs = true
  } catch (e) { out.opfs = e.name === 'NotFoundError' ? false : 'ERR:' + e.name }
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    out.swRegistered = regs.length > 0
    out.swControlled = !!navigator.serviceWorker.controller
  } catch (e) { out.swRegistered = 'ERR:' + e.name }
  return out
}

const registerSwFn = async () => {
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise((res) => {
      const t = setInterval(() => {
        if (navigator.serviceWorker.controller) { clearInterval(t); res() }
      }, 50)
      setTimeout(() => { clearInterval(t); res() }, 3000)
    })
  }
  return { controlled: !!navigator.serviceWorker.controller, scope: reg.scope }
}

function diff(before, after) {
  // for each bucket: 'cleared' if before truthy & after false; 'kept' if both truthy; else note
  const keys = ['localStorage', 'sessionStorage', 'cookie', 'indexedDB', 'cacheStorage', 'opfs', 'swRegistered']
  const d = {}
  for (const k of keys) {
    const b = before[k]; const a = after[k]
    if (b === true && a === false) d[k] = 'CLEARED'
    else if (b === true && a === true) d[k] = 'kept'
    else d[k] = `b=${b} a=${a}`
  }
  return d
}

async function runCase(browser, base, { name, trigger }) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push('pageerror:' + e.message))

  await page.goto(base + '/')
  const sw = await page.evaluate(registerSwFn)
  await page.evaluate(seedFn)
  const before = await page.evaluate(inventoryFn)

  let triggerResult = null
  if (trigger.type === 'fetch') {
    triggerResult = await page.evaluate(async (path) => {
      const r = await fetch(path)
      return { status: r.status, csdHeader: r.headers.get('clear-site-data'), body: await r.text() }
    }, trigger.path)
    await page.waitForTimeout(800)
    await page.goto(base + '/') // reload fresh document
  } else if (trigger.type === 'navigate') {
    const resp = await page.goto(base + trigger.path)
    triggerResult = { status: resp.status(), csdHeader: resp.headers()['clear-site-data'] }
    await page.waitForTimeout(800)
    await page.goto(base + '/')
  }
  await page.waitForTimeout(300)
  const after = await page.evaluate(inventoryFn)

  await ctx.close()
  return { name, sw, before, after, diff: diff(before, after), triggerResult, consoleErrors }
}

;(async () => {
  const { server, port } = await startServer()
  const base = `http://127.0.0.1:${port}`
  // PW_CHROME lets you point at a pre-installed Chromium whose revision doesn't
  // match playwright-core's bundled one; unset -> Playwright resolves its own.
  const browser = await chromium.launch({
    ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
    headless: true,
    args: ['--no-sandbox'],
  })
  const out = { chromium: browser.version(), base, cases: {} }

  const cases = [
    { name: 'A1_sw_synth', trigger: { type: 'fetch', path: '/sw-clear' } },
    { name: 'A2_sw_passthrough', trigger: { type: 'fetch', path: '/sw-passthrough' } },
    { name: 'B_network_fetch', trigger: { type: 'fetch', path: '/network-clear' } },
    { name: 'C_network_navigate', trigger: { type: 'navigate', path: '/network-clear' } },
  ]
  for (const c of cases) {
    try {
      out.cases[c.name] = await runCase(browser, base, c)
    } catch (e) {
      out.cases[c.name] = { name: c.name, error: e.message }
    }
  }

  await browser.close()
  server.close()
  console.log(JSON.stringify(out, null, 2))
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
