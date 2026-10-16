import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridgeClient } from '../src/client.js'

// A call that names no workspace goes to whichever app tab the user focused
// last; a pinned client names one on every call, so an unattended consumer
// stays on its workspace while the user moves around.
describe('bridge client workspace pin', () => {
  let submitted: Array<Record<string, unknown>>

  beforeEach(() => {
    submitted = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        submitted.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({id: 'c1'}), {status: 202})
      }
      return new Response(JSON.stringify({status: 'completed', result: {ok: true, value: null}}), {status: 200})
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const client = (options: {workspaceId?: string} = {}) =>
    createBridgeClient({bridgeUrl: 'http://127.0.0.1:1', token: 'TOKEN', pollIntervalMs: 1, ...options})

  it('names the pinned workspace on a call that names none', async () => {
    await client({workspaceId: 'ws-pinned'}).runCommand({type: 'update-block', id: 'b1', content: 'x'})

    expect(submitted[0]!.workspaceId).toBe('ws-pinned')
  })

  it('leaves a call that names its own workspace alone', async () => {
    await client({workspaceId: 'ws-pinned'}).runCommand({type: 'search', query: 'x', workspaceId: 'ws-other'})

    expect(submitted[0]!.workspaceId).toBe('ws-other')
  })

  // The MCP tools pass `workspaceId: undefined` when the caller gave none.
  it('pins a call whose workspaceId is present but undefined', async () => {
    await client({workspaceId: 'ws-pinned'}).runCommand({type: 'search', query: 'x', workspaceId: undefined})

    expect(submitted[0]!.workspaceId).toBe('ws-pinned')
  })

  it('takes the pin from AGENT_RUNTIME_WORKSPACE', async () => {
    vi.stubEnv('AGENT_RUNTIME_WORKSPACE', 'ws-from-env')

    await client().runCommand({type: 'ping'})

    expect(submitted[0]!.workspaceId).toBe('ws-from-env')
  })

  it('names no workspace when unpinned', async () => {
    vi.stubEnv('AGENT_RUNTIME_WORKSPACE', '')

    await client().runCommand({type: 'ping'})

    expect(submitted[0]).not.toHaveProperty('workspaceId')
  })
})
