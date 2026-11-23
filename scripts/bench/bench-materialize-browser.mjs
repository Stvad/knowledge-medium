/**
 * Browser materialization benchmark (WebKit or Chromium, OPFS, persistent profile).
 *
 *   node scripts/bench/bench-materialize-browser.mjs [records] [reps] [output.json] [flags]
 *
 * Positional records/reps/output are kept for old invocations; flags override them:
 *   --records N --reps N --out FILE --browser webkit|chromium --vfs coop-sync|write-ahead
 *   --window N --random-ids --drop-triggers a,b --drop-indexes --rebuild-derived --bulk-load --per-row-fts
 *   --cache-kb N (total page cache, split across connections as production does)
 *   --modes none,e2ee --scenarios initial,echo-repass --timeout-min N
 * `write-ahead` is Chromium-only (production's VFS there: one writer + one reader).
 */
import {createServer} from 'vite'
import {chromium, webkit} from 'playwright'
import {resolve, join, dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {writeFile, mkdtemp, mkdir, rm} from 'node:fs/promises'

const argv = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--records', '--reps', '--out', '--browser', '--vfs', '--window',
  '--drop-triggers', '--cache-kb', '--modes', '--scenarios', '--timeout-min'])
const flag = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) positional.push(argv[i])
  else if (FLAGS_WITH_VALUE.has(argv[i])) flag[argv[i]] = argv[++i]
  else flag[argv[i]] = true
}
const num = (v, fallback) => v === undefined ? fallback : Number(v)
const list = v => v === undefined ? undefined : v.split(',').filter(Boolean)
const records = num(flag['--records'], num(positional[0], 1000))
const reps = num(flag['--reps'], num(positional[1], 3))
const outputPath = flag['--out'] ?? positional[2] ?? 'tmp/materialize-browser.json'
const browserName = flag['--browser'] ?? 'webkit'
const vfs = flag['--vfs'] ?? 'coop-sync'
const timeoutMin = num(flag['--timeout-min'], 5)
if (![records, reps].every(n => Number.isInteger(n) && n > 0)) {
  throw new Error('Usage: node scripts/bench/bench-materialize-browser.mjs [records] [reps] [output.json] [flags]; see the file header')
}
if (!['webkit', 'chromium'].includes(browserName)) throw new Error('--browser must be webkit or chromium')
if (!['coop-sync', 'write-ahead'].includes(vfs)) throw new Error('--vfs must be coop-sync or write-ahead')
if (vfs === 'write-ahead' && browserName !== 'chromium') throw new Error('--vfs write-ahead needs --browser chromium')
const benchOptions = {
  records, reps, vfs,
  window: num(flag['--window'], undefined),
  modes: list(flag['--modes']), scenarios: list(flag['--scenarios']),
  dropTriggers: list(flag['--drop-triggers']),
  dropIndexes: flag['--drop-indexes'] === true, rebuildDerived: flag['--rebuild-derived'] === true,
  randomIds: flag['--random-ids'] === true, bulkLoad: flag['--bulk-load'] === true,
  perRowFts: flag['--per-row-fts'] === true, cacheKb: num(flag['--cache-kb'], undefined),
}
await mkdir(dirname(outputPath), {recursive: true})
const server = await createServer({
  configFile: false, root: process.cwd(), envFile: false,
  resolve: {alias: {
    '@': resolve('src'),
    '@knowledge-medium/agent-cli/protocol': resolve('packages/agent-cli/src/protocol.ts'),
  }},
  optimizeDeps: {entries: ['scripts/bench/materialize-browser.html'], include: ['@powersync/web', '@scure/base']},
  server: {host: '127.0.0.1', port: 0},
})
const profile = await mkdtemp(join(tmpdir(), `materialize-${browserName}-`))
let browser
let timeout
try {
  await server.listen()
  const address = server.httpServer.address()
  // Persistent mode: WebKit's private mode has no OPFS; Chromium gets the same shape for parity.
  browser = await (browserName === 'chromium' ? chromium : webkit).launchPersistentContext(profile, {headless: true})
  const page = await browser.newPage()
  page.on('pageerror', e => console.error(e))
  page.on('console', msg => console.error(msg.text()))
  await page.goto(`http://127.0.0.1:${address.port}/scripts/bench/materialize-browser.html`)
  const result = await Promise.race([
    page.evaluate(async options => {
      const {runBrowserMaterializeBench} = await import('/scripts/bench/materialize-browser.ts')
      return runBrowserMaterializeBench(options)
    }, benchOptions),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Browser benchmark exceeded ${timeoutMin} minutes`)), timeoutMin * 60_000)
    }),
  ])
  await writeFile(outputPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({browser: browserName, count: result.count, repetitions: result.repetitions, userAgent: result.userAgent, vfs: result.vfs, variant: result.variant, output: outputPath}))
} finally {
  clearTimeout(timeout)
  await browser?.close()
  await server.close()
  await rm(profile, {recursive: true, force: true})
}
