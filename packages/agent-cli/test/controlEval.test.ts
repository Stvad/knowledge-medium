import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {execFile} from 'node:child_process'
import http from 'node:http'
import {AddressInfo} from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {saveContributorSelection} from '../src/config'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cliScript = path.resolve(here, '../dist/cli.js')

interface StubBridge {
  baseUrl: string
  commands: Array<Record<string, unknown>>
  requests: string[]
  setWorkspaceId: (workspaceId: string | null) => void
  close: () => Promise<void>
}

const startStubBridge = async (): Promise<StubBridge> => {
  const commands: Array<Record<string, unknown>> = []
  const requests: string[] = []
  const results = new Map<string, unknown>()
  let nextCommandId = 1
  let workspaceId: string | null = null
  let clientId = 'client-1'
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`)
      const send = (status: number, value: unknown) => {
        res.writeHead(status, {'content-type': 'application/json'})
        res.end(JSON.stringify(value))
      }
      if (req.method === 'GET' && req.url === '/health') return send(200, {ok: true})
      if (req.method === 'GET' && req.url === '/runtime/whoami') {
        return send(200, {
          clientId,
          audience: {userId: 'user-1', workspaceId, label: 'stub'},
          scope: 'read-write',
          connected: true,
          clientLastSeen: Date.now(),
        })
      }
      if (req.method === 'POST' && req.url === '/runtime/commands') {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        commands.push(command)
        const id = `command-${nextCommandId++}`
        results.set(id, 'stub-ok')
        if (command.type === 'eval' && String(command.code).includes('window.location.reload()')) {
          clientId = 'client-2'
        }
        return send(202, {id})
      }
      const commandMatch = req.method === 'GET' && req.url?.match(/^\/runtime\/commands\/([^/]+)$/)
      if (commandMatch) {
        const id = decodeURIComponent(commandMatch[1]!)
        return send(200, {
          id,
          status: 'completed',
          result: {ok: true, value: results.get(id)},
          clientId,
          targetClientId: clientId,
          createdAt: 1,
          deliveredAt: 2,
          completedAt: 3,
        })
      }
      return send(404, {error: 'not found'})
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    commands,
    requests,
    setWorkspaceId: value => { workspaceId = value },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

let tempDir: string
let tokenFile: string
let selectionDir: string
let bridge: StubBridge

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-control-eval-'))
  tokenFile = path.join(tempDir, 'agent-token.json')
  selectionDir = path.join(tempDir, 'selections')
  await fs.writeFile(tokenFile, JSON.stringify({profiles: {default: {token: 'STUB-TOKEN'}}}))
  bridge = await startStubBridge()
})

afterEach(async () => {
  await bridge.close()
  await fs.rm(tempDir, {recursive: true, force: true})
  vi.unstubAllEnvs()
})

const runCli = (args: string[]) => {
  const env = {
    ...process.env,
    AGENT_RUNTIME_PROFILE: '',
    AGENT_RUNTIME_TOKEN: '',
    AGENT_RUNTIME_TOKEN_FILE: tokenFile,
    AGENT_RUNTIME_CONTRIBUTOR_DIR: selectionDir,
    AGENT_RUNTIME_CONTRIBUTOR_ID: '',
    AGENT_RUNTIME_URL: bridge.baseUrl,
  }
  delete env.AGENT_RUNTIME_WORKSPACE
  return execFileAsync(process.execPath, [cliScript, ...args], {env})
}

describe('CLI control eval attribution', {timeout: 30_000}, () => {
  it('navigates with no active workspace and no contributor selection', async () => {
    const result = await runCli(['navigate', '#research'])

    expect(JSON.parse(result.stdout)).toMatchObject({ok: true, hash: '#research'})
    expect(bridge.commands).toEqual([{
      type: 'eval',
      code: 'window.location.hash = "research"',
      contributorId: null,
    }])
    expect(bridge.requests.filter(request => request === 'GET /runtime/whoami')).toEqual([])
  })

  it('does not apply an explicit contributor override to navigation control evals', async () => {
    await runCli(['--contributor', 'override-id', 'navigate', '#research'])

    expect(bridge.commands[0]).toEqual({
      type: 'eval',
      code: 'window.location.hash = "research"',
      contributorId: null,
    })
    expect(bridge.requests.filter(request => request === 'GET /runtime/whoami')).toEqual([])
  })

  it('reloads and reconnects without a workspace even when a contributor override is set', async () => {
    const result = await runCli(['--contributor', 'override-id', 'reload'])

    expect(JSON.parse(result.stdout)).toMatchObject({ok: true, reconnected: {clientId: 'client-2'}})
    expect(bridge.commands).toEqual([{
      type: 'eval',
      code: 'setTimeout(() => window.location.reload(), 100)',
      contributorId: null,
    }])
    expect(bridge.requests.filter(request => request === 'GET /runtime/whoami')).toHaveLength(2)
    expect(bridge.commands.some(command => command.type === 'list-contributors')).toBe(false)
  })

  it('keeps an ordinary graph eval attributed to its saved profile/workspace contributor', async () => {
    bridge.setWorkspaceId('workspace-active')
    vi.stubEnv('AGENT_RUNTIME_CONTRIBUTOR_DIR', selectionDir)
    await saveContributorSelection('default', 'workspace-active', 'saved-agent-id')

    await runCli(['eval', 'return 42'])

    expect(bridge.commands[0]).toMatchObject({
      type: 'eval',
      code: 'return 42',
      workspaceId: 'workspace-active',
      contributorId: 'saved-agent-id',
    })
  })
})
