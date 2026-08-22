import {describe, expect, it, vi} from 'vitest'
import {createChannelDelivery} from '../src/channelDelivery'
import {statedRunFailure} from '../src/runFailure'

const deliver = (fetchImpl: typeof fetch) => createChannelDelivery({
  port: 8790, secret: 's3cret', secretHeader: 'x-km-channel-secret', hint: 'hint', fetchImpl,
})

/** The cause the sender attached, which is what the engine reads. */
const causeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (thrown: unknown) => thrown)
  expect(error).toBeTruthy()
  return statedRunFailure(error)
}

describe('channel delivery states its own failure cause', () => {
  it('attaches the status the listener chose, not a sentence about it', async () => {
    const send = vi.fn(async () => new Response('busy', {status: 503}))
    expect(await causeOf(deliver(send as unknown as typeof fetch)({content: 'x', meta: {}})))
      .toMatchObject({kind: 'network', retryable: true})
  })

  it('keeps a 404 terminal — a wrong port is not an outage', async () => {
    const send = vi.fn(async () => new Response('nope', {status: 404}))
    expect(await causeOf(deliver(send as unknown as typeof fetch)({content: 'x', meta: {}})))
      .toMatchObject({kind: 'task', retryable: false})
  })

  it('attaches a transport cause when no response ever arrived', async () => {
    // The message here matches no classifier pattern on purpose: the point
    // is that the cause travels as a value, so the wording cannot matter.
    const send = vi.fn(async () => { throw Object.assign(new Error('… …'), {name: 'TimeoutError'}) })
    expect(await causeOf(deliver(send as unknown as typeof fetch)({content: 'x', meta: {}})))
      .toMatchObject({kind: 'network', retryable: true})
  })

  it('carries the shared secret and posts the event as JSON', async () => {
    const send = vi.fn(async () => new Response('ok', {status: 200}))
    await deliver(send as unknown as typeof fetch)({content: 'hello', meta: {watcher: 'w'}})
    const [, init] = send.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-km-channel-secret']).toBe('s3cret')
    expect(JSON.parse(init.body as string)).toEqual({content: 'hello', meta: {watcher: 'w'}})
  })

  it('rejects an unusable port at wiring time, not as a per-delivery outage', () => {
    // A port fetch cannot use makes every delivery reject locally, which the
    // retry path would read as a transport outage and defer forever. It is a
    // configuration error, so it should surface where it is configured.
    expect(() => createChannelDelivery({
      port: 70_000, secret: null, secretHeader: 'x', hint: 'hint',
    })).toThrow()
  })

  it('refuses a port fetch will not connect to, at wiring time', () => {
    // `new URL` accepts these; only the request fails, locally and
    // identically every time, which the retry path reads as an outage.
    expect(() => createChannelDelivery({
      port: 6000, secret: null, secretHeader: 'x', hint: 'hint',
    })).toThrow(/refuses to connect/)
  })

  it('resolves silently on a 2xx', async () => {
    const send = vi.fn(async () => new Response('ok', {status: 200}))
    await expect(deliver(send as unknown as typeof fetch)({content: 'x', meta: {}})).resolves.toBeUndefined()
  })
})
