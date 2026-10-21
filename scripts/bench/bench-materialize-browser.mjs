import {createServer} from 'vite'
import {webkit} from 'playwright'
import {resolve, join} from 'node:path'
import {tmpdir} from 'node:os'
import {writeFile, mkdtemp, rm} from 'node:fs/promises'

const count = Number(process.argv[2] ?? 1000)
const reps = Number(process.argv[3] ?? 3)
if (![count, reps].every(n => Number.isInteger(n) && n > 0)) {
  throw new Error('Usage: node scripts/bench/bench-materialize-browser.mjs [positive record count] [positive repetitions] [output.json]')
}
const server = await createServer({
  configFile: false, root: process.cwd(), envFile: false,
  resolve: {alias: {
    '@': resolve('src'),
    '@knowledge-medium/agent-cli/protocol': resolve('packages/agent-cli/src/protocol.ts'),
  }},
  optimizeDeps: {entries: ['scripts/bench/materialize-browser.html'], include: ['@powersync/web', '@scure/base']},
  server: {host: '127.0.0.1', port: 0},
})
const profile = await mkdtemp(join(tmpdir(), 'materialize-webkit-'))
let browser
let timeout
try {
  await server.listen()
  const address = server.httpServer.address()
  browser = await webkit.launchPersistentContext(profile, {headless: true})
  const page = await browser.newPage()
  page.on('pageerror', e => console.error(e))
  page.on('console', msg => console.error(msg.text()))
  await page.goto(`http://127.0.0.1:${address.port}/scripts/bench/materialize-browser.html`)
  const result = await Promise.race([
    page.evaluate(async ({count, reps}) => {
      const {runBrowserMaterializeBench} = await import('/scripts/bench/materialize-browser.ts')
      return runBrowserMaterializeBench(count, reps)
    }, {count, reps}),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Browser benchmark exceeded five minutes')), 300_000)
    }),
  ])
  await writeFile(process.argv[4] ?? 'tmp/materialize-browser.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify({count: result.count, repetitions: result.repetitions, userAgent: result.userAgent, output: process.argv[4] ?? 'tmp/materialize-browser.json'}))
} finally {
  clearTimeout(timeout)
  await browser?.close()
  await server.close()
  await rm(profile, {recursive: true, force: true})
}
