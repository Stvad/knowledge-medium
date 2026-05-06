// @vitest-environment node
/**
 * New Block facade tests (spec §5.2). Covers:
 *   - sync getters (data, peek, get, peekProperty)
 *   - throw paths (BlockNotLoadedError on cold cache)
 *   - subscribe: fires on cache mutation
 *   - write sugar (set / setContent / delete) routes through repo.mutate
 *   - repo.load(id, opts) hydrates the requested neighborhood
 *   - childIds / children expose handles backed by repo.childIds /
 *     repo.children
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BlockNotFoundError,
  BlockNotLoadedError,
  ChangeScope,
  codecs,
  defineProperty,
  type BlockData,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Block } from './block'
import { Repo } from './repo'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  return {h, cache, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const titleProp = defineProperty<string>('title', {
  codec: codecs.string,
  defaultValue: 'untitled',
  changeScope: ChangeScope.BlockDefault,
})

describe('Block.data / peek (sync)', () => {
  it('throws BlockNotLoadedError when the row isn\'t in cache', () => {
    const b = new Block(env.repo, 'cold')
    expect(() => b.data).toThrow(BlockNotLoadedError)
    expect(b.peek()).toBeUndefined()
  })

  it('returns BlockData after the cache holds the row', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'b1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'hi'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 'b1')
    expect(b.data.content).toBe('hi')
    expect(b.peek()).toEqual(b.data)
  })

  it('peek returns undefined before any load; null is reserved for repo.load missing-row signal', () => {
    const b = new Block(env.repo, 'missing')
    expect(b.peek()).toBeUndefined()
  })

  it('after repo.load returns null, peek surfaces null and data throws BlockNotFoundError', async () => {
    // Pre-condition: no row.
    const b = new Block(env.repo, 'no-such')
    expect(b.peek()).toBeUndefined()
    expect(() => b.data).toThrow(BlockNotLoadedError)

    // load returns null and marks the id as confirmed-missing.
    const loaded = await env.repo.load('no-such')
    expect(loaded).toBeNull()

    // Now peek says null (not undefined), data throws BlockNotFoundError.
    expect(b.peek()).toBeNull()
    expect(() => b.data).toThrow(BlockNotFoundError)
  })

  it('subscribe fires on transition into confirmed-missing (markMissing notifies)', async () => {
    const b = new Block(env.repo, 'sub-missing')
    const seen: Array<unknown> = []
    const unsub = b.subscribe(d => seen.push(d))
    try {
      await env.repo.load('sub-missing')
      expect(b.peek()).toBeNull()
      // Listener fired once with the new state (null = confirmed missing).
      expect(seen).toEqual([null])
    } finally {
      unsub()
    }
  })

  it('the missing marker clears once a snapshot lands (sync-applied insert)', async () => {
    const b = new Block(env.repo, 'late-arrival')
    await env.repo.load('late-arrival')
    expect(b.peek()).toBeNull()

    // Simulate a sync-applied insert by writing through the repo.
    await env.repo.tx(
      tx => tx.create({id: 'late-arrival', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(b.peek()).not.toBeNull()
    expect(b.data.id).toBe('late-arrival')
  })
})

describe('Block.get / peekProperty (codec at boundary)', () => {
  it('decodes via the schema codec and substitutes defaultValue when absent', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 'p1')
    expect(b.get(titleProp)).toBe('untitled')  // defaultValue substituted

    await env.repo.mutate.setProperty({id: 'p1', schema: titleProp, value: 'Inbox'})
    expect(b.get(titleProp)).toBe('Inbox')
  })

  it('peekProperty returns undefined when the property is absent (no defaulting)', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 'p2')
    expect(b.peekProperty(titleProp)).toBeUndefined()
  })
})

describe('Block.subscribe', () => {
  it('fires the listener on cache mutation with the latest BlockData', async () => {
    await env.repo.tx(
      tx => tx.create({id: 's1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 's1')
    const seen: Array<BlockData | null> = []
    const unsub = b.subscribe(d => seen.push(d))
    try {
      await env.repo.mutate.setContent({id: 's1', content: 'edited'})
      expect(seen.at(-1)?.content).toBe('edited')
    } finally {
      unsub()
    }
  })
})

describe('Block.childIds / children / parent', () => {
  beforeEach(async () => {
    // p → c1 / c2
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'p', id: 'c1'})
    await env.repo.mutate.createChild({parentId: 'p', id: 'c2'})
  })

  it('childIds returns the repo.childIds handle ordered by (orderKey, id)', async () => {
    const b = new Block(env.repo, 'p')
    const ids = await b.childIds.load()
    expect(ids).toEqual(['c1', 'c2'])
  })

  it('childIds is identity-stable with repo.query.childIds', () => {
    const b = new Block(env.repo, 'p')
    expect(b.childIds).toBe(env.repo.query.childIds({id: 'p'}))
  })

  it('children returns the repo.children handle with full BlockData rows', async () => {
    const b = new Block(env.repo, 'p')
    const rows = await b.children.load()
    expect(rows.map(r => r.id)).toEqual(['c1', 'c2'])
  })

  it('parent returns the parent Block whenever this block is loaded', () => {
    const c = new Block(env.repo, 'c1')
    const p = c.parent
    expect(p?.id).toBe('p')
    expect(p?.data.id).toBe('p')
  })

  it('parent returns null at the workspace root', () => {
    const p = new Block(env.repo, 'p')
    expect(p.parent).toBeNull()
  })

  it('parent returns the facade even when the parent row hasn\'t been hydrated', async () => {
    // Drop only p so c1's parentId points at an uncached row.
    env.cache.deleteSnapshot('p')
    const c = new Block(env.repo, 'c1')
    const parentFacade = c.parent
    expect(parentFacade?.id).toBe('p')
    // Caller can hydrate via the returned facade.
    await parentFacade?.load()
    expect(parentFacade?.data.id).toBe('p')
  })
})

describe('Block.set / setContent / delete (write sugar)', () => {
  it('set routes through repo.mutate.setProperty (one tx)', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'w1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 'w1')
    await b.set(titleProp, 'Hello')
    expect(b.get(titleProp)).toBe('Hello')
  })

  it('setContent routes through repo.mutate.setContent', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'w2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'pre'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 'w2')
    await b.setContent('post')
    expect(b.data.content).toBe('post')
  })

  it('delete subtree-deletes (mirrors legacy Block.delete)', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'w3', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'w3', id: 'w3-c'})
    const b = new Block(env.repo, 'w3')
    await b.delete()
    expect(env.cache.getSnapshot('w3')!.deleted).toBe(true)
    expect(env.cache.getSnapshot('w3-c')!.deleted).toBe(true)
  })
})

describe('repo.load', () => {
  beforeEach(async () => {
    // gp → p → c1 / c2  (mini three-level tree)
    await env.repo.tx(async tx => {
      await tx.create({id: 'gp', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'gp', id: 'p'})
    await env.repo.mutate.createChild({parentId: 'p',  id: 'c1'})
    await env.repo.mutate.createChild({parentId: 'p',  id: 'c2'})
    // Drop the cache so loads do real work. (Easier than re-creating the
    // harness without the commit-walk hydration.)
    for (const id of ['gp', 'p', 'c1', 'c2']) env.cache.deleteSnapshot(id)
  })

  it('repo.load(id) hydrates just the row', async () => {
    const got = await env.repo.load('p')
    expect(got?.id).toBe('p')
    expect(env.cache.getSnapshot('p')).toBeDefined()
    expect(env.cache.getSnapshot('c1')).toBeUndefined()
  })

  it('repo.load(id, {children: true}) hydrates immediate children', async () => {
    await env.repo.load('p', {children: true})
    expect(env.cache.getSnapshot('c1')).toBeDefined()
    expect(env.cache.getSnapshot('c2')).toBeDefined()
  })

  it('repo.load(id, {ancestors: true}) hydrates the parent chain', async () => {
    await env.repo.load('c1', {ancestors: true})
    expect(env.cache.getSnapshot('c1')).toBeDefined()
    expect(env.cache.getSnapshot('p')).toBeDefined()
    expect(env.cache.getSnapshot('gp')).toBeDefined()
  })

  it('repo.load(id, {descendants: true}) hydrates the full subtree', async () => {
    await env.repo.load('gp', {descendants: true})
    for (const id of ['gp', 'p', 'c1', 'c2']) expect(env.cache.getSnapshot(id)).toBeDefined()
  })

  it('repo.load(id, {descendants: 1}) clips at depth 1', async () => {
    await env.repo.load('gp', {descendants: 1})
    expect(env.cache.getSnapshot('gp')).toBeDefined()
    expect(env.cache.getSnapshot('p')).toBeDefined()
    // c1 / c2 are at depth 2; clipped.
    expect(env.cache.getSnapshot('c1')).toBeUndefined()
  })

  it('returns null for a missing id without polluting the cache', async () => {
    const got = await env.repo.load('does-not-exist')
    expect(got).toBeNull()
    expect(env.cache.getSnapshot('does-not-exist')).toBeUndefined()
  })

  it('concurrent load(id) + load(id, {children: true}) both hydrate fully', async () => {
    // Regression for a prior bug: `dedupLoad(id, ...)` keyed only by id
    // could merge the two calls into one promise driven by whichever
    // started first. The plain loader didn't fetch children, so the
    // children-requesting caller's expectation was silently dropped.
    // The fix is to NOT use the id-keyed dedupLoad path in repo.load
    // (each call does its own work; cache.setSnapshot is idempotent).
    const [r1, r2] = await Promise.all([
      env.repo.load('p'),
      env.repo.load('p', {children: true}),
    ])
    expect(r1?.id).toBe('p')
    expect(r2?.id).toBe('p')
    // The children-requesting caller's neighborhood DID land.
    expect(env.cache.getSnapshot('c1')).toBeDefined()
    expect(env.cache.getSnapshot('c2')).toBeDefined()
  })
})
