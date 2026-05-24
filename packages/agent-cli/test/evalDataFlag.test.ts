/**
 * CLI-level coverage for `kmagent eval --data` / `--data-json`. These
 * tests pin the user-visible behaviour:
 *   - reading a JSON file from disk and threading the parsed value
 *     through the wire envelope as `data`
 *   - parsing an inline JSON string the same way
 *   - rejecting both flags together (the only mutex the CLI enforces
 *     locally before any HTTP call)
 *
 * We don't drive a real bridge here — a tiny stub HTTP server stands
 * in, captures the submitted command body, and serves a canned
 * "completed" result so the CLI exits cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cliScript = path.resolve(here, '../dist/cli.js')

interface StubBridge {
  baseUrl: string
  receivedBody: Promise<unknown>
  close: () => Promise<void>
}

const startStubBridge = async (): Promise<StubBridge> => {
  let resolveBody!: (value: unknown) => void
  const receivedBody = new Promise<unknown>((resolve) => {
    resolveBody = resolve
  })

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({ok: true}))
        return
      }

      if (req.method === 'POST' && req.url === '/runtime/commands') {
        const parsed = body ? JSON.parse(body) : null
        resolveBody(parsed)
        res.writeHead(202, {'content-type': 'application/json'})
        res.end(JSON.stringify({id: 'cmd-stub-1'}))
        return
      }

      if (req.method === 'GET' && req.url?.startsWith('/runtime/commands/')) {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({
          id: 'cmd-stub-1',
          status: 'completed',
          result: {ok: true, value: 'stub-ok'},
          clientId: 'client-1',
          targetClientId: 'client-1',
          createdAt: 1,
          deliveredAt: 2,
          completedAt: 3,
        }))
        return
      }

      res.writeHead(404)
      res.end()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}`

  return {
    baseUrl,
    receivedBody,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
    }),
  }
}

let tempDir: string
let tokenFile: string
let bridge: StubBridge

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-eval-'))
  tokenFile = path.join(tempDir, 'agent-token.json')
  // Seed a token so the CLI's authedRequest has something to send.
  await fs.writeFile(tokenFile, JSON.stringify({
    profiles: {default: {token: 'STUB-TOKEN', savedAt: Date.now()}},
  }))
  bridge = await startStubBridge()
})

afterEach(async () => {
  await bridge.close()
  await fs.rm(tempDir, {recursive: true, force: true})
})

const runEval = async (args: string[]) =>
  execFileAsync(process.execPath, [cliScript, 'eval', ...args], {
    env: {
      ...process.env,
      AGENT_RUNTIME_PROFILE: '',
      AGENT_RUNTIME_TOKEN: '',
      AGENT_RUNTIME_TOKEN_FILE: tokenFile,
      AGENT_RUNTIME_URL: bridge.baseUrl,
    },
  })

describe('kmagent eval --data / --data-json', () => {
  it('reads JSON from --data <path> and binds it as `data` in the wire envelope', async () => {
    const dataPath = path.join(tempDir, 'plans.json')
    const payload = {plans: [{id: 'p-1', op: 'rename'}, {id: 'p-2', op: 'merge'}]}
    await fs.writeFile(dataPath, JSON.stringify(payload))

    await runEval(['--data', dataPath, 'return data.plans.length'])
    const body = await bridge.receivedBody as Record<string, unknown>

    expect(body.type).toBe('eval')
    expect(body.code).toBe('return data.plans.length')
    expect(body.data).toEqual(payload)
  })

  it('parses --data-json inline and threads it through as `data`', async () => {
    await runEval(['--data-json', '{"x":1,"y":[true,null]}', 'return data.x'])
    const body = await bridge.receivedBody as Record<string, unknown>

    expect(body.type).toBe('eval')
    expect(body.data).toEqual({x: 1, y: [true, null]})
  })

  it('omits `data` from the envelope when neither flag is passed', async () => {
    await runEval(['return 42'])
    const body = await bridge.receivedBody as Record<string, unknown>

    expect(body.type).toBe('eval')
    expect(body.code).toBe('return 42')
    expect('data' in body).toBe(false)
  })

  it('rejects --data and --data-json together with a clear error', async () => {
    await expect(runEval([
      '--data', path.join(tempDir, 'unused.json'),
      '--data-json', '{}',
      'return 1',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('--data <path> or --data-json'),
    })
  })

  it('errors when --data-json is not valid JSON', async () => {
    await expect(runEval([
      '--data-json', '{not json',
      'return 1',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('--data-json must be valid JSON'),
    })
  })
})
