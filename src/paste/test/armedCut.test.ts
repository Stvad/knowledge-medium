// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { armCut, disarmCut, getArmedCut, markCutPasted, matchArmedCut, subscribeArmedCut } from '../armedCut'

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
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a'], foreignRootId: 'first-result'})
    markCutPasted(getArmedCut()!.cutId)
    await armCut('- b', {workspaceId: 'ws-1', rootIds: ['b'], foreignRootId: 'second-result'})
    expect((await matchArmedCut('- a', 'ws-1'))?.kind).toBe('mismatch')
    expect(await matchArmedCut('- b', 'ws-1')).toMatchObject({
      kind: 'match', cut: {rootIds: ['b'], foreignRootId: 'second-result', pasted: false},
    })
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
  const storageKey = 'knowledge-medium:armed-cut'
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

  it.each([undefined, 'result'])('a cut armed by another tab retains its boundary (%s)', async foreignRootId => {
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a'], foreignRootId})
    const written = store.get(storageKey)!
    expect(JSON.parse(written).foreignRootId).toBe(foreignRootId)
    disarmCut()
    store.set(storageKey, written)
    const match = await matchArmedCut('- a', 'ws-1')
    expect(match?.kind).toBe('match')
    expect(match?.cut.foreignRootId).toBe(foreignRootId)

    markCutPasted(match!.cut.cutId)
    const pasted = JSON.parse(store.get(storageKey)!)
    expect(pasted.pasted).toBe(true)
    expect(pasted.foreignRootId).toBe(foreignRootId)
    expect(getArmedCut()?.foreignRootId).toBe(foreignRootId)
  })

  it('keeps the cut in memory when storage reads work but writes fail', async () => {
    // A full quota: reads still return whatever was stored before.
    store.set(storageKey, 'stale')
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: (key: string) => { store.delete(key) },
    })

    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a']})

    expect((await matchArmedCut('- a', 'ws-1'))?.kind).toBe('match')
    expect(getArmedCut()?.rootIds).toEqual(['a'])
  })

  it.each([['an empty', ''], ['a non-string', 7]])('refuses a cut with %s result boundary', async (_, foreignRootId) => {
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a'], foreignRootId: 'result'})
    for (const [key, raw] of store) store.set(key, JSON.stringify({...JSON.parse(raw), foreignRootId}))
    expect(await matchArmedCut('- a', 'ws-1')).toBeNull()
  })

  it('ignores a malformed record rather than acting on it', async () => {
    await armCut('- a', {workspaceId: 'ws-1', rootIds: ['a']})
    for (const key of store.keys()) store.set(key, '{"rootIds": 3}')
    expect(await matchArmedCut('- a', 'ws-1')).toBeNull()
  })
})
