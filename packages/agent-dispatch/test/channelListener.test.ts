import {describe, expect, it, vi} from 'vitest'
import {handleChannelPost} from '../src/channelListener'
import {createDeliveryDedup} from '../src/deliveryDedup'

const post = (body: unknown, dispatch: () => Promise<void>, dedup = createDeliveryDedup()) =>
  handleChannelPost({body: typeof body === 'string' ? body : JSON.stringify(body), dedup, dispatch})

const event = (id: string) => ({content: 'do the thing', meta: {event_id: id}})

describe('channel listener', () => {
  it('dispatches a well-formed event and reports it delivered', async () => {
    const dispatch = vi.fn(async () => {})
    expect(await post(event('e-1'), dispatch)).toEqual({status: 200, body: 'ok'})
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed body WITHOUT claiming anything', async () => {
    // One try around parse and dispatch reported both as 400 and left a
    // claim behind — and the sender reads 400 as a permanent task failure.
    const dedup = createDeliveryDedup()
    const dispatch = vi.fn(async () => {})
    expect(await post('not json', dispatch, dedup)).toMatchObject({status: 400})
    expect(dispatch).not.toHaveBeenCalled()
    expect(dedup.size).toBe(0)
  })

  it('releases the claim when the session was never reached, so the id is not wedged', async () => {
    // A dispatch that rejected left its claim `pending` forever: every later
    // delivery of that id answered 503 until eviction or a restart.
    const dedup = createDeliveryDedup()
    const failing = vi.fn(async () => { throw new Error('Not connected') })
    expect(await post(event('e-1'), failing, dedup)).toMatchObject({status: 503})

    const ok = vi.fn(async () => {})
    expect(await post(event('e-1'), ok, dedup)).toEqual({status: 200, body: 'ok'})
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('answers a repeat of a CONFIRMED delivery as a duplicate', async () => {
    const dedup = createDeliveryDedup()
    const dispatch = vi.fn(async () => {})
    await post(event('e-1'), dispatch, dedup)
    expect(await post(event('e-1'), dispatch, dedup)).toEqual({status: 200, body: 'duplicate'})
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('answers a repeat of an IN-FLIGHT delivery as unknown, never as done', async () => {
    // 200 here would tell a query sender its rows are with the session, and
    // it would advance its cursor past work that may never have run.
    const dedup = createDeliveryDedup()
    let release: (() => void) | null = null
    const slow = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const inFlight = post(event('e-1'), slow, dedup)

    expect(await post(event('e-1'), vi.fn(async () => {}), dedup)).toMatchObject({status: 503})
    release?.()
    expect(await inFlight).toEqual({status: 200, body: 'ok'})
  })
})
