/** End-to-end test of the bridge HTTP server. We spawn the built script
 *  as a child process on a random port and exercise it over the wire:
 *  token auth, per-client queues, and client-gone failure modes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { UNKNOWN_TOKEN_MARKER } from '../src/protocol.js'

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

let sharedServer: {baseUrl: string, stop: () => Promise<void>}
let baseUrl: string
const bridgeSecret = 'BRIDGE-SECRET'
const bridgeHeaders = {'x-agent-runtime-secret': bridgeSecret}
// One server for the whole file. Each test wipes state via the
// secret-gated reset route (enabled by AGENT_RUNTIME_TEST_RESET) instead
// of paying a fresh spawn + port-bind per case — which also removes the
// pick-port/spawn TOCTOU race from every-test down to a single occurrence.
// `spawnBridgeServer` is defined further below, but the reference is safe:
// vitest doesn't invoke a `beforeAll` callback until the module has fully
// evaluated, by which point the const is initialized.
beforeAll(async () => {
  sharedServer = await spawnBridgeServer({
    AGENT_RUNTIME_BRIDGE_SECRET: bridgeSecret,
    AGENT_RUNTIME_TEST_RESET: 'true',
  })
  baseUrl = sharedServer.baseUrl
})

afterAll(() => sharedServer.stop())

beforeEach(async () => {
  const response = await fetch(`${baseUrl}/runtime/test/reset`, {
    method: 'POST',
    headers: bridgeHeaders,
  })
  expect(response.ok).toBe(true)
})

const registerClient = async (clientId: string, body: object, url = baseUrl) => {
  const response = await fetch(`${url}/runtime/clients/${clientId}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...bridgeHeaders},
    body: JSON.stringify(body),
  })
  expect(response.ok).toBe(true)
}

/** How every bridge in this file is spawned. The stdin pipe, never written,
 *  plus `--exit-on-stdin-close` ties the bridge's life to its spawner's: a
 *  worker that dies before afterAll (a timeout, an interrupted gate) closes
 *  the pipe as it goes, and the bridge exits instead of orphaning. */
const bridgeSpawnSpec = (port: number, env: Record<string, string>) => ({
  args: [serverScript, '--exit-on-stdin-close'],
  env: {AGENT_RUNTIME_PORT: String(port), AGENT_RUNTIME_HOST: '127.0.0.1', ...env},
  stdio: ['pipe', 'ignore', 'pipe'] as const,
})

/** Spawn the bridge server on a free port, wait for /health, and return a
 *  stop() to kill it. Backs both the shared per-file server (beforeAll
 *  above) and tests that need their own env — e.g. a TTL override the
 *  shared server's fixed-at-startup env can't apply without a restart. */
const spawnBridgeServer = async (
  env: Record<string, string>,
): Promise<{baseUrl: string, stop: () => Promise<void>}> => {
  const port = await pickPort()
  const spec = bridgeSpawnSpec(port, env)
  const proc = spawn(process.execPath, spec.args, {env: {...process.env, ...spec.env}, stdio: [...spec.stdio]})
  await waitForReady(port)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (!proc.killed) {
        proc.kill('SIGKILL')
        await new Promise(resolve => proc.once('exit', resolve))
      }
    },
  }
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
    const {error} = await response.json()
    expect(error).toContain(UNKNOWN_TOKEN_MARKER)
    expect(error).toMatch(/no app tab is connected/i)
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
    expect((await response.json()).error).toContain(UNKNOWN_TOKEN_MARKER)
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

  /** Submits a ping as TOKEN-A and delivers it to alice-tab; returns its id. */
  const deliverPing = async (url = baseUrl) => {
    const submission = await fetch(`${url}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'ping'}),
    })
    const {id} = await submission.json() as {id: string}
    await fetch(`${url}/runtime/commands/next?clientId=alice-tab&timeoutMs=2000`, {headers: bridgeHeaders})
    return id
  }

  const statusOf = async (id: string, url = baseUrl) =>
    await (await fetch(`${url}/runtime/commands/${id}`, {headers: {authorization: 'Bearer TOKEN-A'}})).json() as {
      status: string, result?: {ok: boolean, value?: unknown, error?: {message: string}},
    }

  it('reports a command completed only once its whole result has arrived', async () => {
    await registerClient('alice-tab', {tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice'}]})
    const id = await deliverPing()

    // The handler counts a result post toward the client's TTL before it
    // reads the body, so a later `lastSeen` proves the post is being handled.
    const lastSeen = async () => {
      const health = await (await fetch(`${baseUrl}/health?detail=1`, {headers: bridgeHeaders})).json() as {clients: Array<{id: string, lastSeen: number}>}
      return health.clients.find(client => client.id === 'alice-tab')!.lastSeen
    }
    const before = await lastSeen()
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(before))

    // A large result reaches the server over several reads; a poll between
    // them must not see a completed command with no result yet.
    const body = JSON.stringify({ok: true, value: 'pong'})
    const post = http.request(`${baseUrl}/runtime/commands/${id}/result`, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...bridgeHeaders, 'x-agent-runtime-client-id': 'alice-tab'},
    })
    const posted = new Promise(resolve => post.on('response', resolve))
    post.write(body.slice(0, 5))
    await vi.waitFor(async () => expect(await lastSeen()).toBeGreaterThan(before))
    expect((await statusOf(id)).status).toBe('delivered')

    post.end(body.slice(5))
    await posted
    expect(await statusOf(id)).toMatchObject({status: 'completed', result: {ok: true, value: 'pong'}})
  })

  it('fails a command whose result is over the size limit, saying why', async () => {
    const server = await spawnBridgeServer({AGENT_RUNTIME_BRIDGE_SECRET: bridgeSecret, AGENT_RUNTIME_MAX_BODY_BYTES: '1000'})
    try {
      await registerClient('alice-tab', {tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice'}]}, server.baseUrl)
      const id = await deliverPing(server.baseUrl)
      const posted = await fetch(`${server.baseUrl}/runtime/commands/${id}/result`, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...bridgeHeaders, 'x-agent-runtime-client-id': 'alice-tab'},
        body: JSON.stringify({ok: true, value: 'x'.repeat(2000)}),
      })
      expect(posted.status).toBe(413)
      const status = await statusOf(id, server.baseUrl)
      expect(status.status).toBe('failed')
      expect(status.result?.error?.message).toContain('exceeds 1000 bytes')
    } finally {
      await server.stop()
    }
  })

  // Regression test for a completed command being reaped ~commandTtlMs after
  // it was CREATED rather than after it FINISHED: a long-running command
  // (kept `delivered` here well past commandTtlMs, standing in for a
  // multi-minute migration) already has a stale createdAt by the time it
  // completes, so aging from createdAt reaps it on the very next request —
  // which is exactly the CLI's own status poll. Needs a dedicated server
  // (own TTL env) since the shared per-file server's TTLs are fixed at
  // startup.
  it('keeps a completed command readable for commandTtlMs after it completed, not after it was created', async () => {
    const {baseUrl: ttlBaseUrl, stop} = await spawnBridgeServer({
      AGENT_RUNTIME_BRIDGE_SECRET: bridgeSecret,
      AGENT_RUNTIME_COMMAND_TTL_MS: '1000',
      AGENT_RUNTIME_INFLIGHT_COMMAND_TTL_MS: '60000',
    })
    try {
      await fetch(`${ttlBaseUrl}/runtime/clients/alice-tab`, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...bridgeHeaders},
        body: JSON.stringify({
          tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice', workspaceId: 'ws-1'}],
        }),
      })

      const submission = await fetch(`${ttlBaseUrl}/runtime/commands`, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
        body: JSON.stringify({type: 'ping'}),
      })
      const {id} = await submission.json()

      await fetch(`${ttlBaseUrl}/runtime/commands/next?clientId=alice-tab&timeoutMs=2000`, {
        headers: bridgeHeaders,
      })

      // Stay `delivered` past commandTtlMs (1s) — bounded only by the much
      // larger inFlightCommandTtlMs (60s) — so createdAt is already stale
      // by the time the command completes.
      await new Promise(resolve => setTimeout(resolve, 1500))

      await fetch(`${ttlBaseUrl}/runtime/commands/${id}/result`, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...bridgeHeaders, 'x-agent-runtime-client-id': 'alice-tab'},
        body: JSON.stringify({ok: true, value: 'pong'}),
      })

      // Poll immediately: cleanup() runs at the top of this very request.
      const status = await fetch(`${ttlBaseUrl}/runtime/commands/${id}`, {
        headers: {authorization: 'Bearer TOKEN-A'},
      })
      expect(status.status).toBe(200)
      const body = await status.json()
      expect(body.status).toBe('completed')
      expect(body.result.value).toBe('pong')

      // Negative control: prove the shrunk TTL is actually in effect. Without
      // this, a broken envDurationMsOverride would silently fall back to the
      // real 10-minute default, every command would stay readable, and the
      // assertions above would pass without pinning anything. Age the same
      // command past commandTtlMs (1s) from completion and confirm it IS
      // reaped.
      await new Promise(resolve => setTimeout(resolve, 1500))
      const expired = await fetch(`${ttlBaseUrl}/runtime/commands/${id}`, {
        headers: {authorization: 'Bearer TOKEN-A'},
      })
      expect(expired.status).toBe(404)
    } finally {
      await stop()
    }
  }, 20_000)

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

// Every tab of a user registers every token of that user, whichever workspace
// it has open — so a workspace switch no longer un-registers an agent's token,
// and the bridge picks which of the user's tabs a call goes to.
describe('a token belongs to its user, not to a workspace', () => {
  const tokenOf = (userId: string) => [{token: 'TOKEN-A', label: 'cli', userId}]

  const registerTab = (workspaceId: string, focusedAt: number) =>
    registerClient(`alice-${workspaceId}`, {
      audience: {userId: 'alice', workspaceId}, focusedAt, tokens: tokenOf('alice'),
    })

  // `alice-ws-2` registers LAST in every case below, and is never the tab
  // expected to serve: registration order alone must not decide the route.
  const registerAliceTabs = async (focus: {ws1: number, ws2: number}) => {
    await registerTab('ws-1', focus.ws1)
    await registerTab('ws-2', focus.ws2)
  }

  const submit = async (body: object) => {
    const response = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(202)
  }

  const nextFor = async (clientId: string): Promise<{type?: string} | null> =>
    (await fetch(`${baseUrl}/runtime/commands/next?clientId=${clientId}&timeoutMs=200`, {
      headers: bridgeHeaders,
    })).json()

  it('sends a call that names a workspace to the tab that has it open', async () => {
    await registerAliceTabs({ws1: 1_000, ws2: 2_000})

    await submit({type: 'page', name: 'x', workspaceId: 'ws-1'})

    expect((await nextFor('alice-ws-1'))?.type).toBe('page')
    expect(await nextFor('alice-ws-2')).toBeNull()
  })

  it('sends a call that names no workspace to the tab focused most recently', async () => {
    await registerAliceTabs({ws1: 2_000, ws2: 1_000})

    await submit({type: 'ping'})
    expect((await nextFor('alice-ws-1'))?.type).toBe('ping')

    // Focus moves to ws-2; ws-1 then re-registers on its own loop turn.
    await registerTab('ws-2', 3_000)
    await registerTab('ws-1', 2_000)
    await submit({type: 'ping'})
    expect((await nextFor('alice-ws-2'))?.type).toBe('ping')
  })

  // The tab then answers or refuses for that workspace itself; the bridge has
  // no business failing a call a tab of the user can explain.
  it('sends a call naming a workspace no tab has open to the tab focused most recently', async () => {
    await registerAliceTabs({ws1: 2_000, ws2: 1_000})

    await submit({type: 'search', query: 'x', workspaceId: 'ws-elsewhere'})

    expect((await nextFor('alice-ws-1'))?.type).toBe('search')
  })

  // A reloaded tab re-registers under a new client id with the focus stamp it
  // kept, while its dead predecessor lingers until the client TTL.
  it('among equally focused tabs, prefers the one that registered last', async () => {
    await registerClient('alice-before-reload', {
      audience: {userId: 'alice', workspaceId: 'ws-1'}, focusedAt: 1_000, tokens: tokenOf('alice'),
    })
    await registerClient('alice-after-reload', {
      audience: {userId: 'alice', workspaceId: 'ws-1'}, focusedAt: 1_000, tokens: tokenOf('alice'),
    })

    await submit({type: 'ping'})

    expect((await nextFor('alice-after-reload'))?.type).toBe('ping')
  })

  // Every poll refreshes a tab's lastSeen, so breaking ties on it would hand
  // the token back and forth between two equally focused live tabs.
  it('among equally focused tabs, keeps preferring the one that connected last', async () => {
    await registerClient('alice-older', {
      audience: {userId: 'alice', workspaceId: 'ws-1'}, focusedAt: null, tokens: tokenOf('alice'),
    })
    await registerClient('alice-newer', {
      audience: {userId: 'alice', workspaceId: 'ws-2'}, focusedAt: null, tokens: tokenOf('alice'),
    })
    // The older tab's next loop turn.
    await registerClient('alice-older', {
      audience: {userId: 'alice', workspaceId: 'ws-1'}, focusedAt: null, tokens: tokenOf('alice'),
    })

    await submit({type: 'ping'})

    expect((await nextFor('alice-newer'))?.type).toBe('ping')
  })

  it('routes a root create-block by the workspace in its data', async () => {
    await registerAliceTabs({ws1: 1_000, ws2: 2_000})

    await submit({type: 'create-block', data: {workspaceId: 'ws-1', content: 'x'}})

    expect((await nextFor('alice-ws-1'))?.type).toBe('create-block')
  })

  it('fails a queued command once its tab stops listing the token that sent it', async () => {
    await registerTab('ws-1', 1_000)
    const response = await fetch(`${baseUrl}/runtime/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer TOKEN-A'},
      body: JSON.stringify({type: 'eval', code: 'return 1'}),
    })
    const {id} = await response.json()

    // Revoked in the app: the tab's next registration no longer lists it.
    await registerClient('alice-ws-1', {audience: {userId: 'alice', workspaceId: 'ws-1'}, tokens: []})

    const status = await (await fetch(`${baseUrl}/runtime/commands/${id}`, {
      headers: {authorization: 'Bearer TOKEN-A'},
    })).json()
    expect(status.status).toBe('failed')
    expect(await nextFor('alice-ws-1')).toBeNull()
  })

  it('whoami reports the workspace a call that names none acts on', async () => {
    await registerAliceTabs({ws1: 2_000, ws2: 1_000})

    const body = await (await fetch(`${baseUrl}/runtime/whoami`, {
      headers: {authorization: 'Bearer TOKEN-A'},
    })).json()

    expect(body.clientId).toBe('alice-ws-1')
    expect(body.audience).toEqual({userId: 'alice', workspaceId: 'ws-1', label: 'cli'})
  })
})

// Facts, not a guessed cause: how many tabs are connected, and whether one
// signed in as the token's user is among them — never who.
describe('an unregistered token reports what the bridge can see', () => {
  const whoamiError = async (token = 'TOKEN-A'): Promise<string> => {
    const response = await fetch(`${baseUrl}/runtime/whoami`, {
      headers: {authorization: `Bearer ${token}`},
    })
    expect(response.status).toBe(401)
    const {error} = await response.json()
    expect(error).toContain(UNKNOWN_TOKEN_MARKER)
    return error
  }

  it('says when no app tab is connected', async () => {
    expect(await whoamiError()).toMatch(/no app tab is connected/i)
  })

  it('says when only tabs of other users are connected', async () => {
    await registerClient('the-tab', {
      audience: {userId: 'alice', workspaceId: 'ws-1'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice'}],
    })
    // Same tab, now signed in as someone else.
    await registerClient('the-tab', {
      audience: {userId: 'bob', workspaceId: 'ws-9'},
      tokens: [{token: 'TOKEN-B', label: 'cli', userId: 'bob'}],
    })

    expect(await whoamiError()).toMatch(/no connected tab is signed in as this token's user/i)
  })

  it('says when a tab of the token\'s user is connected but does not list it', async () => {
    await registerClient('alice-tab', {
      audience: {userId: 'alice', workspaceId: 'ws-1'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice'}],
    })
    await registerClient('alice-tab', {audience: {userId: 'alice', workspaceId: 'ws-1'}, tokens: []})

    expect(await whoamiError()).toMatch(/signed in as this token's user but does not list it/i)
  })

  it('says how many tabs are connected for a token none has listed', async () => {
    await registerClient('bob-tab', {
      audience: {userId: 'bob', workspaceId: 'ws-9'},
      tokens: [{token: 'TOKEN-B', label: 'cli', userId: 'bob'}],
    })

    expect(await whoamiError('NEVER-REGISTERED'))
      .toMatch(/1 app tab is connected.*no tab has listed this token since the bridge started/i)
  })

  // The 401 needs no bridge secret, and /health hides who is connected from
  // anyone without one — so the message must not name users either.
  it('names no user to a caller holding an unregistered token', async () => {
    await registerClient('alice-tab', {
      audience: {userId: 'alice-user-id', workspaceId: 'ws-1'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice-user-id'}],
    })
    await registerClient('alice-tab', {audience: {userId: 'alice-user-id', workspaceId: 'ws-1'}, tokens: []})

    expect(await whoamiError()).not.toContain('alice-user-id')
    expect(await whoamiError('NEVER-REGISTERED')).not.toContain('alice-user-id')
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

  it('isolates event streams by user', async () => {
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

  // The tab that holds the token is not necessarily the one whose watchers
  // fire: events are the user's, whichever of their tabs emits them.
  it('feeds the token\'s stream from every tab of its user, whatever workspace each has open', async () => {
    await registerClient('alice-ws-2-tab', {
      audience: {userId: 'alice', workspaceId: 'ws-2'},
      tokens: [{token: 'TOKEN-A', label: 'cli', userId: 'alice'}],
    })
    await registerAlice()

    await postEvent('alice-ws-2-tab', {type: 'watcher-settled', watcher: 'from-ws-2'})

    const body = await nextEvents('TOKEN-A', '?afterSeq=0&timeoutMs=100').then(response => response.json())
    expect(body.events.map((entry: {event: {watcher: string}}) => entry.event.watcher)).toEqual(['from-ws-2'])
  })

  // Local-only user ids are the typed name, so two browser profiles can share
  // one; a stream follows the tabs that list the token, not the user id.
  it('keeps the streams of two tokens apart even when their tabs share a user id', async () => {
    await registerClient('profile-1-tab', {
      audience: {userId: 'dev', workspaceId: 'ws-1'}, tokens: [{token: 'TOKEN-P1', label: 'cli', userId: 'dev'}],
    })
    await registerClient('profile-2-tab', {
      audience: {userId: 'dev', workspaceId: 'ws-2'}, tokens: [{token: 'TOKEN-P2', label: 'cli', userId: 'dev'}],
    })

    await postEvent('profile-2-tab', {type: 'watcher-settled', watcher: 'profile-2-only'})

    const body = await nextEvents('TOKEN-P1', '?afterSeq=0&timeoutMs=100').then(response => response.json())
    expect(body.events).toEqual([])
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

describe('agent runtime bridge process', () => {
  // Stands in for a vitest worker: spawns a bridge exactly as this file does,
  // prints its pid, and idles until it is killed.
  const spawnerScript = `
    const {spawn} = require('node:child_process')
    const {args, env, stdio} = JSON.parse(process.argv[1])
    const bridge = spawn(process.execPath, args, {env: {...process.env, ...env}, stdio})
    console.log(bridge.pid)
  `
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('exits when the process that spawned it dies without stopping it', async () => {
    const port = await pickPort()
    const spawner = spawn(process.execPath, ['-e', spawnerScript, JSON.stringify(bridgeSpawnSpec(port, {AGENT_RUNTIME_BRIDGE_SECRET: bridgeSecret}))], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const bridgePid = await new Promise<number>((resolve, reject) => {
      spawner.stdout.once('data', chunk => resolve(Number(String(chunk).trim())))
      spawner.once('exit', code => reject(new Error(`the spawner exited (${code}) before starting a bridge`)))
    })
    try {
      await waitForReady(port)
      spawner.kill('SIGKILL')
      await vi.waitFor(() => expect(isAlive(bridgePid)).toBe(false), {timeout: 10_000, interval: 50})
    } finally {
      if (isAlive(bridgePid)) process.kill(bridgePid, 'SIGKILL')
    }
  }, 20_000)
})
