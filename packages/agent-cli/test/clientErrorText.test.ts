import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBridgeClient } from '../src/client.js'

// App error text can echo stored ids and names; the client is the one place a
// bridge error becomes a CLI / MCP message, so it is neutralized there.
describe('bridge client error text', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const failWith = (status: Record<string, unknown>) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({id: 'c1'}), {status: 202})
        : new Response(JSON.stringify(status), {status: 200})))
  }

  const client = () => createBridgeClient({bridgeUrl: 'http://127.0.0.1:1', token: 'TOKEN', pollIntervalMs: 1})
  const hostile = 'block x' + '\nfake: ok' + '\u202Eevil'

  it('neutralizes a failed result', async () => {
    failWith({status: 'completed', result: {ok: false, error: {message: hostile}}})
    const error = await client().runCommand({type: 'ping'}).catch((e: unknown) => e as Error) as Error
    expect(error.message).toMatch(/block x/)
    expect(error.message).not.toMatch(/[\n\u202E]/)
  })

  it('neutralizes a failed command', async () => {
    failWith({status: 'failed', result: {ok: false, error: {message: hostile}}})
    const error = await client().runCommand({type: 'ping'}).catch((e: unknown) => e as Error) as Error
    expect(error.message).not.toMatch(/[\n\u202E]/)
  })
})
