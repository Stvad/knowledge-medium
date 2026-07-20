/** End-to-end test of the bridge HTTP server. We spawn the built script
 *  as a child process on a random port and exercise it over the wire:
 *  token auth, per-client queues, and client-gone failure modes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverScript = path.resolve(here, '../dist/server.js')

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
const unknownTokenMessage =
  'Agent token is not registered with the local bridge. ' +
  'Open or focus the app tab for the same workspace, then retry; if needed, run `kmagent connect` to pair a fresh token. ' +
  'Common causes: the bridge restarted, the app tab disconnected or idled out, the token was revoked, or the CLI is using a token/profile from another workspace or browser profile.'

// One server for the whole file. Each test wipes state via the
// secret-gated reset route (enabled by AGENT_RUNTIME_TEST_RESET) instead
// of paying a fresh spawn + port-bind per case — which also removes the
// pick-port/spawn TOCTOU race from every-test down to a single occurrence.
beforeAll(async () => {
  const port = await pickPort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn('node', [serverScript], {
    env: {
      ...process.env,
      AGENT_RUNTIME_PORT: String(port),
      AGENT_RUNTIME_HOST: '127.0.0.1',
      AGENT_RUNTIME_BRIDGE_SECRET: bridgeSecret,
      AGENT_RUNTIME_TEST_RESET: 'true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  await waitForReady(port)
})

afterAll(async () => {
  if (server && !server.killed) {
    server.kill('SIGKILL')
    await new Promise(resolve => server.once('exit', resolve))
  }
})

beforeEach(async () => {
  const response = await fetch(`${baseUrl}/runtime/test/reset`, {
    method: 'POST',
    headers: bridgeHeaders,
  })
  expect(response.ok).toBe(true)
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

    const summary = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'runtime-summary'}),
    })
    expect(summary.status).toBe(202)

    const write = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'eval', code: 'return 1'}),
    })
    expect(write.status).toBe(403)
  })

  it('derives the read-only allowlist from the command registry', async () => {
    await registerClient('alice-tab', {
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1', scope: 'read-only'}],
    })

    // A verb classified `readOnly: true` in knownCommandRegistry (not in
    // the old hand-listed switch) is accepted — proving the allowlist is
    // registry-derived, not a stale literal set.
    const read = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'search', query: 'anything'}),
    })
    expect(read.status).toBe(202)

    // A verb classified `readOnly: false` is denied.
    const write = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'create-block', content: 'nope'}),
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
    expect(await response.json()).toEqual({error: unknownTokenMessage})
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
    expect(await response.json()).toEqual({error: unknownTokenMessage})
  })

  it('does not expire a token owned by a newer client when an older duplicate registration drops it', async () => {
    await registerClient('alice-tab-old', {
      audience: {userId: 'alice', workspaceId: 'ws-1'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })
    await registerClient('alice-tab-new', {
      audience: {userId: 'alice', workspaceId: 'ws-1'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })

    await registerClient('alice-tab-old', {tokens: []})

    const response = await fetch(`${baseUrl}/runtime/whoami`, {
      headers: {authorization: 'Bearer TOKEN-A'},
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.clientId).toBe('alice-tab-new')
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

  it('allows command status polling after the submitting token re-registers under a new client id', async () => {
    await registerClient('alice-tab', {
      audience: {userId: 'alice', workspaceId: 'ws-1'},
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

    await registerClient('alice-tab-after-hmr', {
      audience: {userId: 'alice', workspaceId: 'ws-1'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })

    const status = await fetch(`${baseUrl}/runtime/commands/${id}`, {
      headers: {authorization: 'Bearer TOKEN-A'},
    })
    expect(status.status).toBe(200)
    const body = await status.json()
    expect(body.status).toBe('delivered')
    expect(body.targetClientId).toBe('alice-tab')
  })

  it('supports concurrent submissions and independent status polling for the same token', async () => {
    await registerClient('alice-tab', {
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
    })

    const submissions = await Promise.all([
      fetch(`${baseUrl}/runtime/commands`, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
        body: JSON.stringify({type: 'ping', payload: 'one'}),
      }),
      fetch(`${baseUrl}/runtime/commands`, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
        body: JSON.stringify({type: 'ping', payload: 'two'}),
      }),
    ])
    expect(submissions.map(response => response.status)).toEqual([202, 202])
    const submitted = await Promise.all(submissions.map(response => response.json()))
    const ids = submitted.map(body => body.id)

    const delivered = await Promise.all([
      fetch(`${baseUrl}/runtime/commands/next?clientId=alice-tab&timeoutMs=2000`, {
        headers: bridgeHeaders,
      }).then(response => response.json()),
      fetch(`${baseUrl}/runtime/commands/next?clientId=alice-tab&timeoutMs=2000`, {
        headers: bridgeHeaders,
      }).then(response => response.json()),
    ])
    expect(delivered.map(command => command.commandId).sort()).toEqual([...ids].sort())

    await Promise.all(delivered.map((command, index) =>
      fetch(`${baseUrl}/runtime/commands/${command.commandId}/result`, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...bridgeHeaders, 'x-agent-runtime-client-id': 'alice-tab'},
        body: JSON.stringify({ok: true, value: `result-${index}`}),
      }),
    ))

    const statuses = await Promise.all(ids.map(id =>
      fetch(`${baseUrl}/runtime/commands/${id}`, {
        headers: {authorization: 'Bearer TOKEN-A'},
      }).then(response => response.json()),
    ))
    expect(statuses.map(status => status.status)).toEqual(['completed', 'completed'])
    expect(statuses.map(status => status.result.value).sort()).toEqual(['result-0', 'result-1'])
  })

  it('blocks side-effecting SELECTs and multi-statement SQL for read-only tokens', async () => {
    await registerClient('alice-tab', {
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1', scope: 'read-only'}],
    })

    // A SELECT prologue is not enough: powersync_clear wipes local data.
    for (const sql of [
      'SELECT powersync_clear(1)',
      'select 1; drop table blocks',
    ]) {
      const response = await fetch(`${baseUrl}/runtime/commands`, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
        body: JSON.stringify({type: 'sql', mode: 'all', sql}),
      })
      expect(response.status, sql).toBe(403)
    }
  })

  it('blocks watch-events registration for read-only tokens', async () => {
    await registerClient('alice-tab', {
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1', scope: 'read-only'}],
    })

    // The registry marks watch-events readOnly: false — the watcher SQL
    // is read-only but the tab EXECUTES it repeatedly on every change,
    // which a read-scoped token must not be able to install.
    const response = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({
        type: 'watch-events',
        consumer: 'snoop',
        watchers: [{kind: 'sql', name: 'w', sql: 'SELECT id FROM blocks'}],
      }),
    })
    expect(response.status).toBe(403)
  })
})

describe('events channel', () => {
  const postEvent = (clientId: string, event: object) =>
    fetch(`${baseUrl}/runtime/events`, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...bridgeHeaders, 'x-agent-runtime-client-id': clientId},
      body: JSON.stringify(event),
    })

  const nextEvents = (token: string, query = '') =>
    fetch(`${baseUrl}/runtime/events/next${query}`, {
      headers: {authorization: `Bearer ${token}`},
    })

  const registerAlice = () => registerClient('alice-tab', {
    audience: {userId: 'alice', workspaceId: 'ws-1'},
    tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
  })

  it('requires a registered client (and the bridge secret) to post events', async () => {
    const noSecret = await fetch(`${baseUrl}/runtime/events`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-agent-runtime-client-id': 'alice-tab'},
      body: JSON.stringify({type: 'watcher-settled'}),
    })
    expect(noSecret.status).toBe(401)

    const unregistered = await postEvent('ghost-tab', {type: 'watcher-settled'})
    expect(unregistered.status).toBe(409)
  })

  it('delivers events to a parked long-poll for the same audience', async () => {
    await registerAlice()

    const bootstrap = await nextEvents('TOKEN-A').then(response => response.json())
    expect(bootstrap).toEqual({events: [], nextSeq: 0})

    // Park a long-poll, then push — the waiter must wake with the event.
    const parked = nextEvents('TOKEN-A', `?afterSeq=${bootstrap.nextSeq}&timeoutMs=5000`)
    const posted = await postEvent('alice-tab', {type: 'watcher-settled', watcher: 'claude-mentions'})
    expect(posted.status).toBe(202)

    const body = await (await parked).json()
    expect(body.nextSeq).toBe(1)
    expect(body.events).toHaveLength(1)
    expect(body.events[0].event).toMatchObject({type: 'watcher-settled', watcher: 'claude-mentions'})
    expect(body.events[0].clientId).toBe('alice-tab')

    // Cursor advanced: nothing new to read.
    const drained = await nextEvents('TOKEN-A', '?afterSeq=1&timeoutMs=100').then(response => response.json())
    expect(drained.events).toEqual([])
  })

  it('buffers events posted before the consumer polls', async () => {
    await registerAlice()
    await postEvent('alice-tab', {type: 'watcher-settled', watcher: 'w1'})
    await postEvent('alice-tab', {type: 'watcher-settled', watcher: 'w2'})

    const body = await nextEvents('TOKEN-A', '?afterSeq=0&timeoutMs=100').then(response => response.json())
    expect(body.events.map((entry: {event: {watcher: string}}) => entry.event.watcher)).toEqual(['w1', 'w2'])
    expect(body.nextSeq).toBe(2)
  })

  it('isolates event streams by audience', async () => {
    await registerAlice()
    await registerClient('bob-tab', {
      audience: {userId: 'bob', workspaceId: 'ws-2'},
      tokens: [{token: 'TOKEN-B', label: 'cli', userId: 'bob', workspaceId: 'ws-2'}],
    })

    await postEvent('alice-tab', {type: 'watcher-settled', watcher: 'alice-only'})

    const bob = await nextEvents('TOKEN-B', '?afterSeq=0&timeoutMs=100').then(response => response.json())
    expect(bob.events).toEqual([])
    const alice = await nextEvents('TOKEN-A', '?afterSeq=0&timeoutMs=100').then(response => response.json())
    expect(alice.events).toHaveLength(1)
  })

  it('flags a stale cursor after a bridge restart instead of parking forever', async () => {
    await registerAlice()
    // Fresh server state (per-test reset): a cursor from a previous
    // bridge lifetime points past the tail.
    const body = await nextEvents('TOKEN-A', '?afterSeq=41&timeoutMs=100').then(response => response.json())
    expect(body).toEqual({events: [], nextSeq: 0, reset: true})
  })

  it('rejects event reads without a token', async () => {
    const response = await fetch(`${baseUrl}/runtime/events/next`)
    expect(response.status).toBe(401)
  })
})
