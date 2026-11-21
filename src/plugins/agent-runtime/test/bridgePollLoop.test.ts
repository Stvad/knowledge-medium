// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAgentRuntimeBridge } from '../bridge.ts'
import type { AgentRuntimeBridgeOptions } from '../protocol.ts'

/** Controllable executeCommand: each call parks until the test resolves
 *  it, so the test decides which commands are slow. vi.hoisted because
 *  the vi.mock factory runs before module-scope consts exist. */
const mockState = vi.hoisted(() => ({
  executions: [] as Array<{
    command: {commandId?: string},
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  }>,
}))

vi.mock('../commands.ts', () => ({
  createAgentRuntimeContext: () => ({}),
  executeCommand: (command: {commandId?: string}) =>
    new Promise((resolve, reject) => {
      mockState.executions.push({command, resolve, reject})
    }),
}))

/** Minimal in-memory bridge server behind window.fetch: registration is
 *  a no-op, /runtime/commands/next long-polls a queue, result posts are
 *  recorded for assertions. */
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}})

let commandQueue: Array<Record<string, unknown>>
let queueWaiters: Array<(command: Record<string, unknown>) => void>
let resultPosts: Array<{commandId: string, body: {ok: boolean}}>
let registrations: Array<Registration>
/** When set, each registration waits here until the test lets it reach the
 *  server, so the test picks the order registrations land in. */
let heldRegistrations: Array<() => void> | null

interface Registration {
  audience: {userId: string | null, workspaceId: string | null}
  tokens: Array<{token: string, userId?: string, workspaceId?: string}>
  focusedAt: number | null
}

const enqueueCommand = (command: Record<string, unknown>) => {
  const waiter = queueWaiters.shift()
  if (waiter) waiter(command)
  else commandQueue.push(command)
}

const fakeBridgeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (/^\/runtime\/clients\//.test(url.pathname)) {
    const land = () => registrations.push(JSON.parse(String(init?.body)) as Registration)
    if (!heldRegistrations) {
      land()
      return jsonResponse({ok: true})
    }
    const held = heldRegistrations
    return new Promise<Response>(resolve => held.push(() => {
      land()
      resolve(jsonResponse({ok: true}))
    }))
  }
  const resultMatch = url.pathname.match(/^\/runtime\/commands\/([^/]+)\/result$/)
  if (resultMatch) {
    resultPosts.push({commandId: resultMatch[1]!, body: JSON.parse(String(init?.body)) as {ok: boolean}})
    return jsonResponse({ok: true})
  }
  if (url.pathname === '/runtime/commands/next') {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true})
      const command = commandQueue.shift()
      if (command) resolve(jsonResponse(command))
      else queueWaiters.push(c => resolve(jsonResponse(c)))
    })
  }
  throw new Error(`Unexpected bridge fetch: ${url.pathname}`)
}

const bridgeOptionsIn = (activeWorkspaceId: string) => ({
  repo: {user: {id: 'user-1'}, activeWorkspaceId},
  runtime: {},
  safeMode: false,
}) as unknown as AgentRuntimeBridgeOptions

const bridgeOptions = bridgeOptionsIn('workspace-1')

let cleanup: (() => void) | null = null

beforeEach(() => {
  commandQueue = []
  queueWaiters = []
  resultPosts = []
  registrations = []
  heldRegistrations = null
  mockState.executions.length = 0
  window.localStorage.setItem('agent-runtime:bridge-secret', 'test-secret')
  vi.spyOn(window, 'fetch').mockImplementation(fakeBridgeFetch)
})

afterEach(() => {
  cleanup?.()
  cleanup = null
  vi.useRealTimers()
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

const resultFor = (commandId: string) => resultPosts.find(post => post.commandId === commandId)

describe('bridge pairing diagnostics', () => {
  it('reports the app tab as not paired at the quiet threshold without fetching', async () => {
    vi.useFakeTimers()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    window.localStorage.removeItem('agent-runtime:bridge-secret')
    cleanup = startAgentRuntimeBridge(bridgeOptions)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(info).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(16_000)
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(
      expect.stringContaining('(registration: not paired); retrying quietly every 60 seconds.'),
    ))
    expect(window.fetch).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('bridge poll loop — command concurrency', () => {
  it('a hung command does not stall later commands', async () => {
    cleanup = startAgentRuntimeBridge(bridgeOptions)

    enqueueCommand({type: 'ping', commandId: 'slow'})
    await vi.waitFor(() => expect(mockState.executions).toHaveLength(1))

    // 'slow' is still unresolved — a second command must still get
    // delivered, executed, and answered.
    enqueueCommand({type: 'ping', commandId: 'fast'})
    await vi.waitFor(() => expect(mockState.executions).toHaveLength(2))
    mockState.executions[1]!.resolve('fast-value')

    await vi.waitFor(() => expect(resultFor('fast')).toBeTruthy())
    expect(resultFor('fast')!.body.ok).toBe(true)
    expect(resultFor('slow')).toBeUndefined()

    // The hung command still completes normally once it resolves.
    mockState.executions[0]!.resolve('slow-value')
    await vi.waitFor(() => expect(resultFor('slow')).toBeTruthy())
    expect(resultFor('slow')!.body.ok).toBe(true)
  })

  it('bounds concurrency: saturated executions park delivery until a slot frees', async () => {
    cleanup = startAgentRuntimeBridge(bridgeOptions)

    for (let i = 0; i < 6; i += 1) enqueueCommand({type: 'ping', commandId: `c${i}`})
    await vi.waitFor(() => expect(mockState.executions).toHaveLength(4))

    // Prove no fifth execution starts while all four slots hang: freeing
    // one slot is the fence — in-order delivery means if c4 had started
    // early we'd see 5 executions BEFORE this resolve, not after.
    expect(mockState.executions).toHaveLength(4)
    mockState.executions[0]!.resolve('done')
    await vi.waitFor(() => expect(mockState.executions).toHaveLength(5))

    mockState.executions.forEach(execution => execution.resolve('done'))
    await vi.waitFor(() => expect(mockState.executions).toHaveLength(6))
    mockState.executions[5]!.resolve('done')
    await vi.waitFor(() => expect(resultPosts).toHaveLength(6))
  })

  it('a failing command reports its error without breaking the loop', async () => {
    cleanup = startAgentRuntimeBridge(bridgeOptions)

    enqueueCommand({type: 'ping', commandId: 'boom'})
    await vi.waitFor(() => expect(mockState.executions).toHaveLength(1))
    mockState.executions[0]!.reject(new Error('kaboom'))

    await vi.waitFor(() => expect(resultFor('boom')).toBeTruthy())
    expect(resultFor('boom')!.body.ok).toBe(false)

    enqueueCommand({type: 'ping', commandId: 'after'})
    await vi.waitFor(() => expect(mockState.executions).toHaveLength(2))
    mockState.executions[1]!.resolve('fine')
    await vi.waitFor(() => expect(resultFor('after')?.body.ok).toBe(true))
  })
})

const storeTokens = (key: string, tokens: string[]) =>
  window.localStorage.setItem(key, JSON.stringify(
    tokens.map(token => ({token, label: token, scope: 'read-write', createdAt: 1}))))

const registeredTokens = (registration: Registration) =>
  registration.tokens.map(t => t.token).sort()

/** One more full poll-loop turn: the loop re-registers after it delivers. */
const nextLoopTurn = async (commandId: string) => {
  const registered = registrations.length
  enqueueCommand({type: 'ping', commandId})
  await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(registered))
}

// The bug this pins: registration used to post only the tokens minted in the
// ACTIVE workspace, so switching workspace in the paired tab un-registered the
// agent's token and every call failed as if the bridge were down.
describe('bridge registration — tokens belong to the user', () => {
  it('registers every token of the signed-in user, whichever workspace is open', async () => {
    storeTokens('agent-runtime:user-tokens:user-1', ['T-user'])
    // Minted while another workspace was active, before tokens were per user.
    storeTokens('agent-runtime:tokens:user-1:22222222-2222-4222-8222-222222222222', ['T-minted-in-ws-2'])
    storeTokens('agent-runtime:user-tokens:someone-else', ['T-other-user'])

    cleanup = startAgentRuntimeBridge(bridgeOptionsIn('workspace-1'))

    await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(0))
    expect(registeredTokens(registrations[0]!)).toEqual(['T-minted-in-ws-2', 'T-user'])
    expect(registrations[0]!.audience).toEqual({userId: 'user-1', workspaceId: 'workspace-1'})
  })

  it('keeps the same tokens registered after the tab switches workspace', async () => {
    storeTokens('agent-runtime:user-tokens:user-1', ['T-user'])
    const options = bridgeOptionsIn('workspace-1')
    cleanup = startAgentRuntimeBridge(options)
    await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(0))

    ;(options.repo as {activeWorkspaceId: string}).activeWorkspaceId = 'workspace-2'
    await nextLoopTurn('after-switch')

    const latest = registrations.at(-1)!
    expect(registeredTokens(latest)).toEqual(['T-user'])
    expect(latest.audience.workspaceId).toBe('workspace-2')
  })
})

// Every tab of the user registers every token, so a revoke made in ONE tab
// must reach the others at once — otherwise the token stays reachable through
// them until each one's next loop turn.
describe('bridge registration — tokens changed in another tab', () => {
  it('re-registers without a token another tab of the same origin revoked', async () => {
    storeTokens('agent-runtime:user-tokens:user-1', ['T-keep', 'T-revoked'])
    cleanup = startAgentRuntimeBridge(bridgeOptions)
    await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(0))

    // What the other tab's revoke leaves in the shared localStorage, and the
    // event the browser then fires in this one.
    storeTokens('agent-runtime:user-tokens:user-1', ['T-keep'])
    window.dispatchEvent(new StorageEvent('storage', {key: 'agent-runtime:user-tokens:user-1'}))

    await vi.waitFor(() => expect(registeredTokens(registrations.at(-1)!)).toEqual(['T-keep']))
  })

  // The server replaces a tab's grants with each registration it receives, so
  // a list read before the revoke must never land after the one read after it.
  it('a revoke is not overwritten by a registration already in flight', async () => {
    storeTokens('agent-runtime:user-tokens:user-1', ['T-keep', 'T-revoked'])
    cleanup = startAgentRuntimeBridge(bridgeOptions)
    await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(0))
    const held: Array<() => void> = []
    heldRegistrations = held

    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(held).toHaveLength(1))
    storeTokens('agent-runtime:user-tokens:user-1', ['T-keep'])
    window.dispatchEvent(new StorageEvent('storage', {key: 'agent-runtime:user-tokens:user-1'}))

    // Lets the newest registration sent so far reach the server first.
    await vi.waitFor(() => {
      held.pop()?.()
      expect(held).toHaveLength(0)
      expect(registeredTokens(registrations.at(-1)!)).toEqual(['T-keep'])
    })
  })

  it('ignores storage changes to other keys', async () => {
    cleanup = startAgentRuntimeBridge(bridgeOptions)
    // Parked on its long poll, the loop has no registration in flight, so the
    // first event's registration, had it made one, would post the list as it
    // stood before the second event's change.
    await vi.waitFor(() => expect(queueWaiters.length).toBeGreaterThan(0))
    const registered = registrations.length

    window.dispatchEvent(new StorageEvent('storage', {key: 'unrelated-setting'}))
    storeTokens('agent-runtime:user-tokens:user-1', ['T-after'])
    window.dispatchEvent(new StorageEvent('storage', {key: 'agent-runtime:user-tokens:user-1'}))

    await vi.waitFor(() => expect(registeredTokens(registrations.at(-1)!)).toEqual(['T-after']))
    expect(registrations.length).toBe(registered + 1)
  })
})

// With every tab of a user holding every token, the bridge picks among them;
// a call that names no workspace goes to the tab focused most recently.
describe('bridge registration — focus stamp', () => {
  // Started unfocused, so the only stamp there can be is the focus event's.
  beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(false) })

  it('re-registers with a focus stamp when the tab gains focus', async () => {
    cleanup = startAgentRuntimeBridge(bridgeOptions)
    await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(0))
    expect(registrations[0]!.focusedAt).toBeNull()

    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(registrations.at(-1)!.focusedAt).toBeTypeOf('number'))
  })

  it('a reloaded tab keeps the focus stamp it had', async () => {
    cleanup = startAgentRuntimeBridge(bridgeOptions)
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(registrations.at(-1)?.focusedAt).toBeTypeOf('number'))
    const stamp = registrations.at(-1)!.focusedAt
    cleanup()

    registrations = []
    cleanup = startAgentRuntimeBridge(bridgeOptions)

    await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(0))
    expect(registrations[0]!.focusedAt).toBe(stamp)
  })

  it('still registers when sessionStorage refuses the stamp', async () => {
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    cleanup = startAgentRuntimeBridge(bridgeOptions)

    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(1))
  })
})
