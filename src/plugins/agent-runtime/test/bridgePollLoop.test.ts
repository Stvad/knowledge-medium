// @vitest-environment jsdom
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

const enqueueCommand = (command: Record<string, unknown>) => {
  const waiter = queueWaiters.shift()
  if (waiter) waiter(command)
  else commandQueue.push(command)
}

const fakeBridgeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (/^\/runtime\/clients\//.test(url.pathname)) return jsonResponse({ok: true})
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

const bridgeOptions = {
  repo: {user: {id: 'user-1'}, activeWorkspaceId: 'workspace-1'},
  runtime: {},
  safeMode: false,
} as unknown as AgentRuntimeBridgeOptions

let cleanup: (() => void) | null = null

beforeEach(() => {
  commandQueue = []
  queueWaiters = []
  resultPosts = []
  mockState.executions.length = 0
  window.localStorage.setItem('agent-runtime:bridge-secret', 'test-secret')
  vi.spyOn(window, 'fetch').mockImplementation(fakeBridgeFetch)
})

afterEach(() => {
  cleanup?.()
  cleanup = null
  window.localStorage.clear()
  vi.restoreAllMocks()
})

const resultFor = (commandId: string) => resultPosts.find(post => post.commandId === commandId)

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
