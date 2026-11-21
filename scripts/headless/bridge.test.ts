import {afterEach, expect, it, vi} from 'vitest'
import {connectBridge} from './bridge'

vi.mock('@knowledge-medium/agent-cli/config', () => ({
  bridgeUrl: () => 'http://bridge.invalid',
  bridgeSecret: async () => 'fixture-secret',
}))
vi.mock('@knowledge-medium/agent-cli/client', () => ({
  loadStoredToken: async () => 'fixture-token',
}))

const config = {mode: 'plaintext' as const, workspaceId: 'scratch', profile: 'test', stateDir: ''}
const user = {id: 'member', name: 'Test'}
const latch = () => {
  let resolve!: () => void
  const wait = new Promise<void>(done => { resolve = done })
  return {wait, resolve}
}

afterEach(() => vi.unstubAllGlobals())

it.each([
  [undefined, 'read-only'],
  [false, 'read-only'],
  [true, 'read-write'],
] as const)('uses writable=%s to register a %s token, then withdraws it and drains the result on shutdown', async (writable, scope) => {
  const execution = latch()
  const acknowledge = latch()
  const received = {tokenScopes: [] as string[][], results: [] as unknown[], finished: [] as string[]}
  let parked: AbortSignal | null | undefined
  let delivered = false
  vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
    const route = new URL(url).pathname
    if (route.startsWith('/runtime/clients/')) {
      const {tokens} = JSON.parse(String(init.body)) as {tokens: {scope: string}[]}
      received.tokenScopes.push(tokens.map(token => token.scope))
    } else if (route.endsWith('/next')) {
      if (!delivered) {
        delivered = true
        return Response.json({type: 'ping', commandId: 'slow'})
      }
      parked = init.signal
      return new Promise<Response>((_resolve, reject) => parked?.addEventListener('abort', () => reject(parked?.reason), {once: true}))
    } else if (route === '/runtime/commands/slow/result') {
      init.signal?.throwIfAborted()
      received.results.push(JSON.parse(String(init.body)))
      await acknowledge.wait
      received.finished.push('result')
    } else {
      throw new Error(`Unexpected test request to ${route}`)
    }
    return Response.json({ok: true})
  })

  const bridge = await connectBridge(writable === undefined ? config : {...config, writable}, user, async () => {
    await execution.wait
    return 'complete'
  })
  try {
    await vi.waitFor(() => expect(parked?.aborted).toBe(false))
    const closing = bridge.close().then(() => { received.finished.push('closed') })
    await vi.waitFor(() => expect(parked?.aborted).toBe(true))
    expect(received.tokenScopes).toEqual([[scope], [scope], []])
    execution.resolve()
    await vi.waitFor(() => expect(received.results).toEqual([{ok: true, value: 'complete'}]))
    acknowledge.resolve()
    await closing
    expect(received.finished).toEqual(['result', 'closed'])
  } finally {
    execution.resolve()
    acknowledge.resolve()
  }
})

it('closes after one token withdrawal attempt when the bridge is unreachable', async () => {
  let withdrawals = 0
  vi.stubGlobal('fetch', async (_url: URL | string, init: RequestInit) => {
    if (init.body && JSON.parse(String(init.body)).tokens.length === 0) withdrawals++
    throw new TypeError('Bridge offline')
  })
  const bridge = await connectBridge(config, user, async () => undefined)
  await expect(bridge.close()).resolves.toBeUndefined()
  expect(withdrawals).toBe(1)
})
