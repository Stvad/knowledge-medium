/** End-to-end test of the bridge HTTP server. We spawn the script as
 *  a child process on a random port and exercise it over the wire —
 *  the server is an .mjs file with no exports, so this is the only
 *  honest way to test the routing behaviour we care about (token
 *  auth, per-client queues, client-gone failure mode). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverScript = path.resolve(here, '../../../../scripts/agent-runtime-server.mjs')

const pickPort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.unref()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const addr = probe.address()
    if (addr && typeof addr === 'object') {
      const port = addr.port
      probe.close(() => resolve(port))
    } else {
      probe.close(() => reject(new Error('no port assigned')))
    }
  })
})

const waitForReady = async (port: number, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch { /* not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Bridge server failed to start on port ${port}`)
}

let server: ChildProcess
let baseUrl: string
const bridgeSecret = 'BRIDGE-SECRET'
const bridgeHeaders = {'x-agent-runtime-secret': bridgeSecret}

beforeEach(async () => {
  const port = await pickPort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn('node', [serverScript], {
    env: {
      ...process.env,
      AGENT_RUNTIME_PORT: String(port),
      AGENT_RUNTIME_HOST: '127.0.0.1',
      AGENT_RUNTIME_BRIDGE_SECRET: bridgeSecret,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  await waitForReady(port)
})

afterEach(async () => {
  if (server && !server.killed) {
    server.kill('SIGKILL')
    await new Promise(resolve => server.once('exit', resolve))
  }
})

const registerClient = async (clientId: string, body: object) => {
  const response = await fetch(`${baseUrl}/runtime/clients/${clientId}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...bridgeHeaders},
    body: JSON.stringify(body),
  })
  expect(response.ok).toBe(true)
}

describe('agent runtime bridge', () => {
  it('rejects browser requests from disallowed origins', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: {origin: 'https://evil.example'},
    })
    expect(response.status).toBe(403)
  })

  it('requires the bridge secret for client registration', async () => {
    const response = await fetch(`${baseUrl}/runtime/clients/alice-tab`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({tokens: []}),
    })
    expect(response.status).toBe(401)
  })

  it('redacts public health details', async () => {
    await registerClient('alice-tab', {
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })

    const publicHealth = await fetch(`${baseUrl}/health`)
    expect(await publicHealth.json()).toEqual({ok: true})

    const detailedHealth = await fetch(`${baseUrl}/health?detail=1`, {
      headers: bridgeHeaders,
    })
    const body = await detailedHealth.json()
    expect(body.clients.map((client: {id: string}) => client.id)).toEqual(['alice-tab'])
  })

  it('rejects commands without a bearer token', async () => {
    const response = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({type: 'ping'}),
    })
    expect(response.status).toBe(401)
  })

  it('blocks mutating commands for read-only tokens', async () => {
    await registerClient('alice-tab', {
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1', scope: 'read-only'}],
    })

    const read = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'sql', mode: 'all', sql: 'select id from blocks limit 1'}),
    })
    expect(read.status).toBe(202)

    const write = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'eval', code: 'return 1'}),
    })
    expect(write.status).toBe(403)
  })

  it('rejects commands with an unknown token', async () => {
    const response = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer not-a-token'},
      body: JSON.stringify({type: 'ping'}),
    })
    expect(response.status).toBe(401)
  })

  it('routes commands to the client whose registration carries the token', async () => {
    await registerClient('alice-tab', {
      audience: {userId: 'alice', workspaceId: 'ws-1'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })
    await registerClient('bob-tab', {
      audience: {userId: 'bob', workspaceId: 'ws-2'},
      tokens: [{token: 'TOKEN-B', label: 'cli', userId: 'bob', workspaceId: 'ws-2'}],
    })

    const submission = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'ping', payload: 'hello-alice'}),
    })
    expect(submission.status).toBe(202)

    // Alice should receive it; Bob's queue stays empty.
    const aliceNext = await fetch(`${baseUrl}/runtime/commands/next?clientId=alice-tab&timeoutMs=2000`, {
      headers: bridgeHeaders,
    })
    const aliceBody = await aliceNext.json()
    expect(aliceBody?.type).toBe('ping')
    expect(aliceBody?.payload).toBe('hello-alice')

    const bobNext = await fetch(`${baseUrl}/runtime/commands/next?clientId=bob-tab&timeoutMs=500`, {
      headers: bridgeHeaders,
    })
    const bobBody = await bobNext.json()
    expect(bobBody).toBeNull()
  })

  it('whoami resolves audience for a token', async () => {
    await registerClient('alice-tab', {
      audience: {userId: 'alice', workspaceId: 'ws-1'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })

    const response = await fetch(`${baseUrl}/runtime/whoami`, {
      headers: {authorization: 'Bearer TOKEN-A'},
    })
    expect(response.ok).toBe(true)
    const body = await response.json()
    expect(body.audience.userId).toBe('alice')
    expect(body.audience.workspaceId).toBe('ws-1')
    expect(body.connected).toBe(true)
  })

  it('drops tokens when the client re-registers without them', async () => {
    await registerClient('alice-tab', {
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })
    let response = await fetch(`${baseUrl}/runtime/whoami`, {
      headers: {authorization: 'Bearer TOKEN-A'},
    })
    expect(response.ok).toBe(true)

    await registerClient('alice-tab', {tokens: []})

    response = await fetch(`${baseUrl}/runtime/whoami`, {
      headers: {authorization: 'Bearer TOKEN-A'},
    })
    expect(response.status).toBe(401)
  })

  it('completes the full submit → deliver → result lifecycle', async () => {
    await registerClient('alice-tab', {
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })

    const submission = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'ping'}),
    })
    expect(submission.status).toBe(202)
    const {id} = await submission.json()

    const next = await fetch(`${baseUrl}/runtime/commands/next?clientId=alice-tab&timeoutMs=2000`, {
      headers: bridgeHeaders,
    })
    const command = await next.json()
    expect(command.commandId).toBe(id)

    await fetch(`${baseUrl}/runtime/commands/${id}/result`, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...bridgeHeaders, 'x-agent-runtime-client-id': 'alice-tab'},
      body: JSON.stringify({ok: true, value: 'pong'}),
    })

    const status = await fetch(`${baseUrl}/runtime/commands/${id}`, {
      headers: {authorization: 'Bearer TOKEN-A'},
    })
    const body = await status.json()
    expect(body.status).toBe('completed')
    expect(body.result.value).toBe('pong')
    expect(body.targetClientId).toBe('alice-tab')
  })
})
