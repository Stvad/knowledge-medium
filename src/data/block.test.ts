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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BlockNotFoundError,
  BlockNotLoadedError,
  ChangeScope,
  codecs,
  defineProperty,
  type BlockData,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Block } from './block'
import { Repo } from './repo'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const {repo, cache} = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
  })
  return {h, cache, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

const titleProp = defineProperty<string>('title', {
  codec: codecs.string,
  defaultValue: 'untitled',
  changeScope: ChangeScope.BlockDefault,
})

const tagsProp = defineProperty<string[]>('tags', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
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

  it('normalizes a cached tombstone to missing on the public facade', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'deleted-row', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'gone'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.delete('deleted-row'), {scope: ChangeScope.BlockDefault})

    const b = new Block(env.repo, 'deleted-row')
    expect(env.cache.getSnapshot('deleted-row')?.deleted).toBe(true)
    expect(b.peek()).toBeNull()
    expect(b.read()).toBeNull()
    expect(() => b.data).toThrow(BlockNotFoundError)
  })

  it('peekRaw exposes a cached tombstone for lifecycle/debug callers', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'raw-deleted-row', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'gone'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.delete('raw-deleted-row'), {scope: ChangeScope.BlockDefault})

    const b = new Block(env.repo, 'raw-deleted-row')
    expect(b.peek()).toBeNull()
    expect(b.peekRaw()).toMatchObject({
      id: 'raw-deleted-row',
      deleted: true,
      content: 'gone',
    })
  })

  it('delete and restore transition the public facade between null and live data', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'restored-row', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'before'}),
      {scope: ChangeScope.BlockDefault},
    )

    const b = env.repo.block('restored-row')
    const seen: Array<string | null> = []
    const unsub = b.subscribe(data => seen.push(data?.content ?? null))
    try {
      await env.repo.tx(tx => tx.delete('restored-row'), {scope: ChangeScope.BlockDefault})
      expect(b.peek()).toBeNull()
      expect(b.read()).toBeNull()
      expect(b.peekRaw()).toMatchObject({id: 'restored-row', deleted: true})

      await env.repo.tx(
        tx => tx.restore('restored-row', {content: 'after'}),
        {scope: ChangeScope.BlockDefault},
      )
      expect(b.peek()).toMatchObject({id: 'restored-row', content: 'after', deleted: false})
      expect(b.read()).toMatchObject({id: 'restored-row', content: 'after', deleted: false})
      expect(b.peekRaw()).toMatchObject({id: 'restored-row', content: 'after', deleted: false})
      expect(seen).toEqual([null, 'after'])
    } finally {
      unsub()
    }
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

describe('Block.load', () => {
  it('skips SQL when the cache already holds a live snapshot (cache fast path)', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'cached', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 'cached')
    expect(b.peek()).not.toBeUndefined()

    let getOptionalCalls = 0
    const origGetOptional = env.h.db.getOptional.bind(env.h.db)
    env.h.db.getOptional = (async (sql: string, params?: unknown[]) => {
      getOptionalCalls += 1
      return origGetOptional(sql, params)
    }) as typeof env.h.db.getOptional

    try {
      const out = await b.load()
      expect(out?.id).toBe('cached')
      expect(getOptionalCalls).toBe(0)
    } finally {
      env.h.db.getOptional = origGetOptional
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // "Must load" semantics — pin the contract so future fast-path edits
  // can't skip SQL on states where the cache is provably stale.
  //
  // load() is "ensure loaded with the latest authoritative state". The
  // cache fast-path is only safe when the cache has data (live snapshot).
  // Two cache states do NOT permit short-circuiting:
  //
  //   1. The confirmed-missing marker — it's a cached prior result.
  //      A sync arrival could have created the row since; the row_events
  //      tail clears the marker eventually, but a caller invoking load()
  //      mid-window must not wait for that drain.
  //
  //   2. A tombstone snapshot (`deleted: true`) — the existing repo.load
  //      contract returns null for soft-deleted (SQL filter on
  //      `deleted = 0`) and side-effects markMissing. Callers that use
  //      `!data` as "not a valid live row" (e.g. `RefPropertyEditor.
  //      blockMatchesTargetTypes`) rely on this.
  //
  // Both tests below assert the SQL round-trip happens — they're the
  // tripwires for an over-eager fast-path.
  // ──────────────────────────────────────────────────────────────────
  describe('load: must-load semantics (no cache-only shortcuts when stale)', () => {
    it('with a missing marker set: load re-runs SQL and surfaces a row that arrived since', async () => {
      // Get into the sticky state: marker present, but the row exists
      // in SQL. A naive `if (cache.isMissing(id)) return null` would be
      // wrong here — load() must hit SQL to find the row.
      await env.repo.tx(
        tx => tx.create({id: 'r1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'live'}),
        {scope: ChangeScope.BlockDefault},
      )
      // Force the cache into "missing" without deleting the row from SQL.
      // markMissing also clears any in-cache snapshot.
      env.cache.markMissing('r1')
      expect(env.cache.isMissing('r1')).toBe(true)
      expect(env.cache.getSnapshot('r1')).toBeUndefined()

      let getOptionalCalls = 0
      const origGetOptional = env.h.db.getOptional.bind(env.h.db)
      env.h.db.getOptional = (async (sql: string, params?: unknown[]) => {
        getOptionalCalls += 1
        return origGetOptional(sql, params)
      }) as typeof env.h.db.getOptional

      try {
        const b = new Block(env.repo, 'r1')
        const out = await b.load()
        // Authoritative answer must reflect SQL truth, not the stale
        // marker — anyone who skips SQL here breaks sync convergence.
        expect(out?.id).toBe('r1')
        expect(out?.content).toBe('live')
        expect(getOptionalCalls).toBeGreaterThanOrEqual(1)
      } finally {
        env.h.db.getOptional = origGetOptional
      }
    })

    it('with a tombstone snapshot in cache: load returns null and goes through SQL', async () => {
      // Soft-deleted snapshot in cache, row still in SQL with deleted=1.
      // The contract: load() filters the same way SQL does (`deleted=0`),
      // so soft-deleted reads as "not a valid live row" → null.
      await env.repo.tx(
        tx => tx.create({id: 'r2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )
      await env.repo.tx(tx => tx.delete('r2'), {scope: ChangeScope.BlockDefault})
      const cached = env.cache.getSnapshot('r2')
      expect(cached?.deleted).toBe(true)  // tombstone is in cache

      let getOptionalCalls = 0
      const origGetOptional = env.h.db.getOptional.bind(env.h.db)
      env.h.db.getOptional = (async (sql: string, params?: unknown[]) => {
        getOptionalCalls += 1
        return origGetOptional(sql, params)
      }) as typeof env.h.db.getOptional

      try {
        const b = new Block(env.repo, 'r2')
        const out = await b.load()
        // Returns null — `!data` callers must keep working on tombstones.
        expect(out).toBeNull()
        // And the SQL round-trip happened (markMissing side-effect ran).
        expect(getOptionalCalls).toBeGreaterThanOrEqual(1)
      } finally {
        env.h.db.getOptional = origGetOptional
      }
    })

    it('cache fast-path clears a prior lastError so a later eviction returns to idle, not error', async () => {
      // The fast-path branch is a successful load — it must clear
      // lastError, mirroring the SQL branch's `lastError = undefined`
      // on resolve. Without this, a prior failed load leaves the error
      // sticky: status() returns 'ready' while the snapshot is cached
      // (hasSnapshot wins), but a later eviction surfaces the stale
      // error through status()/read() instead of dropping back to
      // 'idle' as a successful load should.
      const b = new Block(env.repo, 'flaky')

      // Phase 1: fail a load.
      const sqlError = new Error('boom')
      const origGetOptional = env.h.db.getOptional.bind(env.h.db)
      env.h.db.getOptional = (async () => { throw sqlError }) as typeof env.h.db.getOptional
      try {
        await expect(b.load()).rejects.toBe(sqlError)
      } finally {
        env.h.db.getOptional = origGetOptional
      }
      expect(b.status()).toBe('error')

      // Phase 2: a snapshot lands in cache (e.g. via sync drain).
      // Hand-write through the cache so we don't go through repo.tx
      // (which would run another SQL round-trip).
      env.cache.applyIfNewer({
        id: 'flaky',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: 'live',
        properties: {},
        references: [],
        createdAt: 1, updatedAt: 1, userUpdatedAt: 1,
        createdBy: 'u', updatedBy: 'u',
        deleted: false,
      }, 'sync')
      // Cache fast-path returns the snapshot (no SQL).
      const out = await b.load()
      expect(out?.content).toBe('live')

      // Phase 3: snapshot evicted. Status should be 'idle' — the fast-
      // path load was successful, prior error must be forgotten.
      env.cache.deleteSnapshot('flaky')
      expect(b.status()).toBe('idle')
    })
  })

  it('falls through to repo.load when the cache has no snapshot', async () => {
    // Create the block through repo.tx (so the row lands in SQL), then
    // evict the cache entry so the next load() has to re-read from SQL.
    await env.repo.tx(
      tx => tx.create({id: 'evicted', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    env.cache.deleteSnapshot('evicted')
    const b = new Block(env.repo, 'evicted')
    expect(b.peek()).toBeUndefined()

    const out = await b.load()
    expect(out?.id).toBe('evicted')
    // After loading, the cache holds it again.
    expect(b.peek()?.id).toBe('evicted')
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

  it('childIds is identity-stable with repo.query.childIds (visible view)', () => {
    const b = new Block(env.repo, 'p')
    // The facade getter speaks the visible/outline view (§9), so it delegates
    // to the `hidePropertyChildren`-keyed handle — same instance the option
    // returns, distinct from the everything-view handle.
    expect(b.childIds).toBe(env.repo.query.childIds({id: 'p', hidePropertyChildren: true}))
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

  it('set(schema, updater) reads the current value and writes the result', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'fn1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 'fn1')
    await b.set(tagsProp, ['a'])
    await b.set(tagsProp, current => [...(current ?? []), 'b'])
    expect(b.get(tagsProp)).toEqual(['a', 'b'])
  })

  it('concurrent set(schema, updater) calls both land (no lost update)', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'fn2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const b = new Block(env.repo, 'fn2')
    await b.set(tagsProp, [])
    // Fire both before awaiting: each updater must read the OTHER's
    // committed write (the serialized write-tx), not the empty snapshot
    // both started from — that's the lost-update the overload prevents.
    await Promise.all([
      b.set(tagsProp, c => [...(c ?? []), 'x']),
      b.set(tagsProp, c => [...(c ?? []), 'y']),
    ])
    expect([...(b.get(tagsProp) ?? [])].sort()).toEqual(['x', 'y'])
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
    // Regression for a prior bug: an id-only in-flight load cache could
    // merge the two calls into one promise driven by whichever started
    // first. The plain loader didn't fetch children, so the
    // children-requesting caller's expectation was silently dropped.
    // The fix is that repo.load does NOT dedup concurrent loads at all
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
