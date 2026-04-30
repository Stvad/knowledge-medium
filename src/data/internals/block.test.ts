// @vitest-environment node
/**
 * New Block facade tests (spec §5.2). Covers:
 *   - sync getters (data, peek, get, peekProperty)
 *   - throw paths (BlockNotLoadedError on cold cache, ChildrenNotLoadedError
 *     when allChildrenLoaded marker isn't set)
 *   - subscribe: fires on cache mutation
 *   - write sugar (set / setContent / delete) routes through repo.mutate
 *   - repo.load(id, opts) populates the cache + markers
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BlockNotFoundError,
  BlockNotLoadedError,
  ChildrenNotLoadedError,
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
  kind: 'string',
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

  it('throws ChildrenNotLoadedError when the marker isn\'t set', () => {
    // Despite the cache having both children (commit walk populated
    // them), the marker is set only by `repo.load(id, {children: true})`.
    const b = new Block(env.repo, 'p')
    expect(() => b.childIds).toThrow(ChildrenNotLoadedError)
  })

  it('returns child ids ordered by (orderKey, id) once the marker is set', async () => {
    await env.repo.load('p', {children: true})
    const b = new Block(env.repo, 'p')
    expect(b.childIds).toEqual(['c1', 'c2'])
    expect(b.children.map(c => c.id)).toEqual(['c1', 'c2'])
  })

  it('parent returns the parent Block when the parent row is in cache', () => {
    const c = new Block(env.repo, 'c1')
    const p = c.parent
    expect(p?.id).toBe('p')
    expect(p?.data.id).toBe('p')
  })

  it('parent returns null at the workspace root', () => {
    const p = new Block(env.repo, 'p')
    expect(p.parent).toBeNull()
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
    expect(env.cache.areChildrenLoaded('p')).toBe(false)
  })

  it('repo.load(id, {children: true}) hydrates immediate children + sets allChildrenLoaded', async () => {
    await env.repo.load('p', {children: true})
    expect(env.cache.getSnapshot('c1')).toBeDefined()
    expect(env.cache.getSnapshot('c2')).toBeDefined()
    expect(env.cache.areChildrenLoaded('p')).toBe(true)
    // Block.childIds works without throwing now.
    expect(new Block(env.repo, 'p').childIds).toEqual(['c1', 'c2'])
  })

  it('repo.load(id, {ancestors: true}) hydrates the parent chain', async () => {
    await env.repo.load('c1', {ancestors: true})
    expect(env.cache.getSnapshot('c1')).toBeDefined()
    expect(env.cache.getSnapshot('p')).toBeDefined()
    expect(env.cache.getSnapshot('gp')).toBeDefined()
  })

  it('repo.load(id, {descendants: true}) hydrates the full subtree + every visited parent\'s marker', async () => {
    await env.repo.load('gp', {descendants: true})
    for (const id of ['gp', 'p', 'c1', 'c2']) expect(env.cache.getSnapshot(id)).toBeDefined()
    expect(env.cache.areChildrenLoaded('gp')).toBe(true)
    expect(env.cache.areChildrenLoaded('p')).toBe(true)
  })

  it('repo.load(id, {descendants: 1}) clips at depth 1, only marking the root', async () => {
    await env.repo.load('gp', {descendants: 1})
    expect(env.cache.getSnapshot('gp')).toBeDefined()
    expect(env.cache.getSnapshot('p')).toBeDefined()
    // c1 / c2 are at depth 2; clipped.
    expect(env.cache.getSnapshot('c1')).toBeUndefined()
    expect(env.cache.areChildrenLoaded('gp')).toBe(true)
    expect(env.cache.areChildrenLoaded('p')).toBe(false)
  })

  it('returns null for a missing id without polluting the cache', async () => {
    const got = await env.repo.load('does-not-exist')
    expect(got).toBeNull()
    expect(env.cache.getSnapshot('does-not-exist')).toBeUndefined()
  })

  it('concurrent load(id) + load(id, {children: true}) BOTH end with children loaded + marker set', async () => {
    // Regression for a prior bug: `dedupLoad(id, ...)` keyed only by id
    // could merge the two calls into one promise driven by whichever
    // started first. The plain loader didn't fetch children, so the
    // children-requesting caller's expectation was silently dropped:
    // after both promises resolved, the cache had the row but no
    // children, and allChildrenLoaded was false. The fix is to NOT use
    // the id-keyed dedupLoad path in repo.load (each call does its own
    // work; cache.setSnapshot is idempotent so we don't double-fire).
    const [r1, r2] = await Promise.all([
      env.repo.load('p'),
      env.repo.load('p', {children: true}),
    ])
    expect(r1?.id).toBe('p')
    expect(r2?.id).toBe('p')
    // The children-requesting caller's neighborhood DID land.
    expect(env.cache.getSnapshot('c1')).toBeDefined()
    expect(env.cache.getSnapshot('c2')).toBeDefined()
    expect(env.cache.areChildrenLoaded('p')).toBe(true)
  })
})
