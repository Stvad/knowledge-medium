import { describe, expect, it, vi } from 'vitest'
import { withAuthRequestDeadline } from './authRequestDeadline'

/** A fetch that never answers on its own: it settles only when its signal aborts. */
const unansweredFetch = () => vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  }))

const AUTH_URL = 'https://project.supabase.co/auth/v1/token?grant_type=refresh_token'
const STORAGE_URL = 'https://project.supabase.co/storage/v1/object/attachments/file'

describe('withAuthRequestDeadline', () => {
  it('rejects an auth request that never gets a response once the deadline passes', async () => {
    const fetch = withAuthRequestDeadline(unansweredFetch(), 20)

    await expect(fetch(AUTH_URL, {method: 'POST'})).rejects.toMatchObject({name: 'TimeoutError'})
  })

  it('applies the deadline to an auth request given as a Request or URL', async () => {
    const fetch = withAuthRequestDeadline(unansweredFetch(), 20)

    await expect(fetch(new URL(AUTH_URL))).rejects.toMatchObject({name: 'TimeoutError'})
    await expect(fetch(new Request(AUTH_URL))).rejects.toMatchObject({name: 'TimeoutError'})
  })

  it('still honours the caller\'s own abort signal on an auth request', async () => {
    const fetch = withAuthRequestDeadline(unansweredFetch(), 60_000)
    const caller = new AbortController()

    const pending = fetch(AUTH_URL, {signal: caller.signal})
    caller.abort(new Error('caller cancelled'))

    await expect(pending).rejects.toThrow('caller cancelled')
  })

  it('still honours the abort signal of a Request input', async () => {
    const fetch = withAuthRequestDeadline(unansweredFetch(), 60_000)
    const caller = new AbortController()

    const pending = fetch(new Request(AUTH_URL, {signal: caller.signal}))
    caller.abort(new Error('caller cancelled'))

    await expect(pending).rejects.toThrow('caller cancelled')
  })

  it('leaves non-auth requests without a deadline, so long storage uploads are not cut off', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    const fetch = withAuthRequestDeadline(inner, 20)
    const init = {method: 'PUT'}

    await fetch(STORAGE_URL, init)

    expect(inner).toHaveBeenCalledWith(STORAGE_URL, init)
  })
})
