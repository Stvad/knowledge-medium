// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { getInitialLayout, prepareInitialLayout, preparedInitialHash, type InitialLayout } from './initialLayout'

// `use()` reads a thenable synchronously only when it carries the fulfilled
// stamp; a cache hit that still suspends costs a fallback flip and React 19's
// 300 ms retry throttle. These pin the stamp and the one-hash contract App
// relies on to hit the prepared entry.
const layout: InitialLayout = {kind: 'waiting', workspaceId: 'ws'}
let nextInstance = 1000
const fakeRepo = () => ({instanceId: nextInstance++}) as unknown as Repo

describe('getInitialLayout', () => {
  it('returns the same promise for the same key, stamped fulfilled once resolved', async () => {
    const repo = fakeRepo()
    const resolver = vi.fn(async () => layout)
    const first = getInitialLayout(repo, '#h', true, 0, resolver)
    expect((first as {status?: string}).status).toBeUndefined()
    await first
    const again = getInitialLayout(repo, '#h', true, 0, resolver) as Promise<InitialLayout> & {status?: string; value?: InitialLayout}
    expect(again).toBe(first)
    expect(again.status).toBe('fulfilled')
    expect(again.value).toBe(layout)
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('evicts a rejected resolution so the next lookup retries', async () => {
    const repo = fakeRepo()
    const failing = vi.fn(async () => { throw new Error('boom') })
    await expect(getInitialLayout(repo, '#h', true, 0, failing)).rejects.toThrow('boom')
    const ok = vi.fn(async () => layout)
    await expect(getInitialLayout(repo, '#h', true, 0, ok)).resolves.toBe(layout)
    expect(ok).toHaveBeenCalledTimes(1)
  })
})

describe('prepareInitialLayout', () => {
  it('records the hash it resolved for, so App keys its first lookup on that string', () => {
    const repo = fakeRepo()
    expect(preparedInitialHash(repo)).toBeUndefined()
    void prepareInitialLayout(repo, false).catch(() => {})
    expect(preparedInitialHash(repo)).toBe(typeof window === 'undefined' ? '' : window.location.hash)
  })
})
