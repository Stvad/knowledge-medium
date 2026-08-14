/**
 * `pair-url` prints a pairing URL for a human to open in the app. Its bare
 * form is deliberately bridge-approval only; `--tokens` adds the
 * `agent-runtime-open-tokens=1` param so the app also opens the token dialog
 * (what `connect` does).
 *
 * `pairingUrl()` itself is covered in config.test.ts. What's pinned here is
 * the CLI wiring — that the flag reaches `openTokensDialog`, and (the part a
 * unit test of `pairingUrl` can't see) that the DEFAULT stays off. Flipping
 * that default would contradict the root README and
 * `plugins/onboarding/outline.ts`, both of which call this "a bridge-only
 * pairing URL".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cliScript = path.resolve(here, '../dist/cli.js')

// `pair-url` calls `ensureBridgeRunning()` first. Pointing
// AGENT_RUNTIME_URL at a stub that answers /health both satisfies that check
// and (because the env var is set) stops the CLI from auto-starting a real
// bridge process.
let stub: http.Server
let stubUrl: string

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({ok: true}))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve))
  const address = stub.address()
  if (typeof address === 'string' || !address) throw new Error('stub did not bind a port')
  stubUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => stub.close(() => resolve()))
})

const pairUrl = async (args: string[] = []) => {
  const {stdout} = await execFileAsync(process.execPath, [cliScript, 'pair-url', ...args], {
    env: {
      ...process.env,
      AGENT_RUNTIME_URL: stubUrl,
      AGENT_RUNTIME_BRIDGE_SECRET: 'bridge-secret',
      AGENT_RUNTIME_APP_URL: 'http://localhost:5173/',
    },
  })
  const url = new URL(stdout.trim())
  return new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1))
}

// Spawns the compiled CLI once or twice; Node startup dominates and stretches
// badly when the gate saturates every core (measured ~0.6s for both spawns
// idle, so the 5s default has too little headroom).
describe('kmagent pair-url', {timeout: 30_000}, () => {
  it('prints a bridge-approval URL with no token dialog by default', async () => {
    const params = await pairUrl()

    expect(params.get('agent-runtime-url')).toBe(stubUrl)
    expect(params.get('agent-runtime-secret')).toBe('bridge-secret')
    expect(params.get('agent-runtime-open-tokens')).toBeNull()
  })

  it('adds the token dialog with --tokens', async () => {
    const params = await pairUrl(['--tokens'])

    expect(params.get('agent-runtime-url')).toBe(stubUrl)
    expect(params.get('agent-runtime-open-tokens')).toBe('1')
  })
})
