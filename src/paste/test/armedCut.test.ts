// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { armCut, disarmCut, getArmedCut, matchArmedCut, subscribeArmedCut } from '../armedCut'

const cut = {workspaceId: 'ws-1', rootIds: ['a', 'b']}

beforeEach(() => disarmCut())

describe('armed cut', () => {
  it('matches the exact text it was armed with, in the same workspace', async () => {
    await armCut('- a\n- b', cut)
    const match = await matchArmedCut('- a\n- b', 'ws-1')
    expect(match).toMatchObject({kind: 'match', cut: {rootIds: ['a', 'b'], workspaceId: 'ws-1'}})
  })

  it('treats CRLF clipboard text as the LF text that was written', async () => {
    await armCut('- a\n- b', cut)
    expect((await matchArmedCut('- a\r\n- b', 'ws-1'))?.kind).toBe('match')
  })

  it('reports a mismatch when the clipboard holds other text', async () => {
    await armCut('- a\n- b', cut)
    expect((await matchArmedCut('- a', 'ws-1'))?.kind).toBe('mismatch')
  })

  it('reports another workspace rather than matching it', async () => {
    await armCut('- a\n- b', cut)
    expect((await matchArmedCut('- a\n- b', 'ws-2'))?.kind).toBe('other-workspace')
  })

  it('answers null when nothing is armed', async () => {
    expect(await matchArmedCut('- a\n- b', 'ws-1')).toBeNull()
  })

  it('a later cut replaces the earlier one', async () => {
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a']})
    await armCut('- b', {workspaceId: 'ws-1', rootIds: ['b']})
    expect((await matchArmedCut('- a', 'ws-1'))?.kind).toBe('mismatch')
    expect(await matchArmedCut('- b', 'ws-1')).toMatchObject({kind: 'match', cut: {rootIds: ['b']}})
  })

  it('disarming by id leaves a newer cut armed', async () => {
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a']})
    const first = getArmedCut()!
    await armCut('- b', {workspaceId: 'ws-1', rootIds: ['b']})
    disarmCut(first.cutId)
    expect(getArmedCut()?.rootIds).toEqual(['b'])
    disarmCut(getArmedCut()!.cutId)
    expect(getArmedCut()).toBeNull()
  })

  it('notifies subscribers and keeps a stable snapshot between changes', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeArmedCut(listener)
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a']})
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getArmedCut()).toBe(getArmedCut())
    disarmCut()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})

describe('armed cut across tabs (shared localStorage)', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('a cut armed by another tab is visible here', async () => {
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a']})
    const written = [...store.entries()]
    disarmCut()
    // Another tab arming = another writer putting the same record in storage.
    for (const [key, value] of written) store.set(key, value)
    expect((await matchArmedCut('- a', 'ws-1'))?.kind).toBe('match')
  })

  it('ignores a malformed record rather than acting on it', async () => {
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a']})
    for (const key of store.keys()) store.set(key, '{"rootIds": 3}')
    expect(await matchArmedCut('- a', 'ws-1')).toBeNull()
  })
})
