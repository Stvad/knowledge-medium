import {afterEach, describe, expect, it, vi} from 'vitest'
import {createBridgeClient, isCommandRejection} from '../src/client'

/** A bridge that accepts the command and then answers it. */
const bridgeAnswering = (result: unknown) => vi.fn(async (url: string | URL) => {
  const href = String(url)
  if (href.endsWith('/runtime/commands')) {
    return new Response(JSON.stringify({id: 'cmd-1'}), {status: 200, headers: {'content-type': 'application/json'}})
  }
  return new Response(JSON.stringify(result), {status: 200, headers: {'content-type': 'application/json'}})
})

/** The poll shape the bridge actually answers with — a bare result body
 *  never reports `completed`, so the client just polls until it times out
 *  and the test would pass on a TIMEOUT rather than on a rejection. */
const completedWith = (result: unknown) => bridgeAnswering({status: 'completed', result})

const client = () => createBridgeClient({bridgeUrl: 'http://127.0.0.1:9999', token: 't', timeoutMs: 2_000})

afterEach(() => { vi.unstubAllGlobals() })

describe('a command the app refused is marked as such', () => {
  it('marks a rejected command, so callers do not retry it as an outage', async () => {
    // The daemon defers transport failures and cools an executor lane while
    // it does. A rejection is an answer — retried, it is answered the same
    // way forever — and treating one as an outage paused unrelated work.
    vi.stubGlobal('fetch', completedWith({ok: false, error: {message: 'updateBlock: block b-1 not found'}}))

    const error = await client().runCommand({name: 'get-block', args: {}} as never)
      .then(() => null, (thrown: unknown) => thrown)

    expect(isCommandRejection(error)).toBe(true)
    expect((error as Error).message).toContain('not found')
  })

  it('does NOT mark a failure to reach the app', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed') }))

    const error = await client().runCommand({name: 'get-block', args: {}} as never)
      .then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeTruthy()
    expect(isCommandRejection(error)).toBe(false)
  })

  it('does NOT mark a command failed because the client went away', async () => {
    // The bridge sets `failed` in exactly one place: a target client that
    // disconnected, whose pending commands are failed with ClientGone. That
    // is the app becoming unreachable — marking it as an answer is what
    // stops the daemon deferring a disconnect, which is the case the
    // deferral exists for.
    vi.stubGlobal('fetch', bridgeAnswering({
      status: 'failed',
      result: {ok: false, error: {name: 'ClientGone', message: 'Target client disconnected'}},
    }))

    const error = await client().runCommand({name: 'get-block', args: {}} as never)
      .then(() => null, (thrown: unknown) => thrown)

    expect(isCommandRejection(error)).toBe(false)
    expect((error as Error).message).toContain('Target client disconnected')
  })

  it('reports a plain value as not-a-rejection', () => {
    expect(isCommandRejection(new Error('boom'))).toBe(false)
    expect(isCommandRejection(null)).toBe(false)
    expect(isCommandRejection('nope')).toBe(false)
  })
})
