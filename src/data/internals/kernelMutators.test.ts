// @vitest-environment node
/**
 * Kernel mutator tests (spec §13.3). Runs through `repo.mutate.X(args)`
 * — the typed-dispatch sugar — so we exercise the full path: registry
 * lookup, scope resolution, args parse, 1-mutator-tx wrap, primitive
 * writes, commit walk to cache.
 *
 * Each mutator gets behaviour coverage. The §13.1 acceptance for
 * Phase 1 calls out that `repo.indent`, `repo.outdent`, `repo.move`,
 * `repo.delete`, `repo.createChild`, `repo.split`, `repo.merge`,
 * `repo.insertChildren` exist and run inside `repo.tx`; these tests
 * pin behaviour at the dispatch surface that the call-site sweep
 * (stage 1.6) will migrate to.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CORE_BLOCK_MERGED_EVENT,
  ChangeScope,
  ParentDeletedError,
  codecs,
  defineProperty,
  type BlockData,
  type CoreBlockMergedEvent,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../repo'
import { aliasesProp, isCollapsedProp } from '@/data/properties'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
  /** Live block data after commit walk. */
  read(id: string): BlockData | undefined
  /** Children ids in (order_key, id) order. */
  childIds(parentId: string | null): Promise<string[]>
}

const setup = async (): Promise<Harness> => {
  // One real PowerSync DB is opened per file (beforeAll) and reset between
  // tests — ~100x cheaper than reopening it for each case. A fresh Repo per
  // test keeps the cache / handle-store / registry isolated.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // Mutator tests assert on user-facing tx side-effects (cache,
    // command_events). Kernel processors firing add follow-up txs
    // that aren't under test here; integration coverage lives in the
    // backlinks plugin processor tests.
    registerKernelProcessors: false,
  })
  return {
    h,
    cache,
    repo,
    read: id => cache.getSnapshot(id),
    childIds: async (parentId) => {
      const rows = parentId === null
        ? await h.db.getAll<{id: string}>("SELECT id FROM blocks WHERE parent_id IS NULL AND deleted = 0 ORDER BY order_key, id")
        : await h.db.getAll<{id: string}>("SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id", [parentId])
      return rows.map(r => r.id)
    },
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// Dispose the per-test Repo's sync observer (started by default in the Repo
// constructor) so its db.onChange subscription doesn't leak onto the shared
// DB; the DB itself is closed once in afterAll.
afterEach(() => { env.repo.stopSyncObserver() })

/** Seed a small tree: root, three children A/B/C at depth 1. */
const seedABC = async () => {
  await env.repo.tx(async tx => {
    await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
  }, {scope: ChangeScope.BlockDefault})
  await env.repo.mutate.createChild({parentId: 'root', id: 'A', content: 'A'})
  await env.repo.mutate.createChild({parentId: 'root', id: 'B', content: 'B'})
  await env.repo.mutate.createChild({parentId: 'root', id: 'C', content: 'C'})
}

// ──── setContent ────

describe('core.setContent', () => {
  it('writes content via repo.mutate.setContent', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'b1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'pre'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.setContent({id: 'b1', content: 'edited'})
    expect(env.read('b1')!.content).toBe('edited')
  })
})

// ──── setProperty ────

describe('core.setProperty', () => {
  const titleProp = defineProperty<string>('title', {
    codec: codecs.string,
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })

  const uiFlagProp = defineProperty<boolean>('ui:flag', {
    codec: codecs.boolean,
    defaultValue: false,
    changeScope: ChangeScope.UiState,
  })

  const prefsFlagProp = defineProperty<boolean>('prefs:flag', {
    codec: codecs.boolean,
    defaultValue: false,
    changeScope: ChangeScope.UserPrefs,
  })

  it('encodes the value via codec and stores under properties[name]', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.setProperty({id: 'p1', schema: titleProp, value: 'Hello'})
    expect(env.read('p1')!.properties.title).toBe('Hello')
  })

  it('derives tx scope from schema.changeScope: a UiState property tags the second tx with UiState', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.setProperty({id: 'p2', schema: uiFlagProp, value: true})
    // The second tx is tagged scope=UiState (not inheriting BlockDefault
    // from the outer registration). source is always 'user' under
    // Phase 2 — the scope identity drives undo bucketing and schema
    // validation, not upload routing.
    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events ORDER BY created_at',
    )
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({scope: ChangeScope.UiState, source: 'user'})
  })

  it('writes collapsed state in BlockDefault scope so it is synced', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p-collapsed', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )

    await env.repo.mutate.setProperty({id: 'p-collapsed', schema: isCollapsedProp, value: true})

    expect(env.read('p-collapsed')!.properties[isCollapsedProp.name]).toBe(true)
    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events ORDER BY created_at',
    )
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({scope: ChangeScope.BlockDefault, source: 'user'})
  })

  it('derives UserPrefs scope from schema.changeScope and uploads when writable', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p-prefs', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )

    await env.repo.mutate.setProperty({id: 'p-prefs', schema: prefsFlagProp, value: true})

    expect(env.read('p-prefs')!.properties[prefsFlagProp.name]).toBe(true)
    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events ORDER BY created_at',
    )
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({scope: ChangeScope.UserPrefs, source: 'user'})
  })

  it('UiState and UserPrefs property writes are allowed in read-only mode', async () => {
    // Pre-seed a target row in a regular repo so the read-only repo
    // has something to write to.
    await env.repo.tx(
      tx => tx.create({id: 'p3', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const ro = await import('../repo').then(m => new m.Repo({
      db: env.h.db,
      cache: env.cache,
      user: {id: 'user-1', name: 'Test'},
      isReadOnly: true,
    }))
    // BlockDefault throws ReadOnlyError; UiState and UserPrefs pass through.
    await expect(
      ro.mutate.setProperty({id: 'p3', schema: titleProp, value: 'no'}),
    ).rejects.toThrow(/read.?only/i)
    await ro.mutate.setProperty({id: 'p3', schema: uiFlagProp, value: true})
    await ro.mutate.setProperty({id: 'p3', schema: prefsFlagProp, value: true})
    // source='user' for both — Phase 2 dropped the local-ephemeral
    // downgrade. The writes queue and the server will refuse them in
    // read-only mode (RLS); the rejection-quarantine surfaces that.
    const events = await env.h.db.getAll<{source: string}>(
      "SELECT source FROM command_events WHERE scope IN ('local-ui', 'user-prefs') ORDER BY created_at",
    )
    expect(events.every(e => e.source === 'user')).toBe(true)
  })
})

// ──── createChild + position variants ────

describe('core.createChild', () => {
  it('appends to parent at position=last by default; uses parent workspace', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-X', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const id = await env.repo.mutate.createChild({parentId: 'p', content: 'hello'})
    const child = env.read(id)!
    expect(child).toMatchObject({parentId: 'p', workspaceId: 'ws-X', content: 'hello'})
  })

  it('respects position=first', async () => {
    await seedABC()
    const id = await env.repo.mutate.createChild({parentId: 'root', id: 'X', content: 'first', position: {kind: 'first'}})
    expect(await env.childIds('root')).toEqual([id, 'A', 'B', 'C'])
  })

  it('respects position={kind:"after", siblingId}', async () => {
    await seedABC()
    const id = await env.repo.mutate.createChild({parentId: 'root', id: 'X', content: 'after-A', position: {kind: 'after', siblingId: 'A'}})
    expect(await env.childIds('root')).toEqual(['A', id, 'B', 'C'])
  })

  it('reveals a collapsed parent when revealParent is set', async () => {
    await seedABC()
    await env.repo.mutate.setProperty({id: 'A', schema: isCollapsedProp, value: true})
    await env.repo.mutate.createChild({parentId: 'A', id: 'A1', revealParent: true})
    expect(env.read('A')!.properties[isCollapsedProp.name]).toBe(false)
  })

  it('leaves a collapsed parent collapsed without revealParent', async () => {
    await seedABC()
    await env.repo.mutate.setProperty({id: 'A', schema: isCollapsedProp, value: true})
    await env.repo.mutate.createChild({parentId: 'A', id: 'A1'})
    expect(env.read('A')!.properties[isCollapsedProp.name]).toBe(true)
  })

  it('respects position={kind:"before", siblingId}', async () => {
    await seedABC()
    const id = await env.repo.mutate.createChild({parentId: 'root', id: 'X', content: 'before-B', position: {kind: 'before', siblingId: 'B'}})
    expect(await env.childIds('root')).toEqual(['A', id, 'B', 'C'])
  })

  it('throws ParentDeletedError when parent is soft-deleted', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'sd-p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.delete({id: 'sd-p'})
    await expect(env.repo.mutate.createChild({parentId: 'sd-p'})).rejects.toThrow(ParentDeletedError)
  })
})

// ──── createSiblingAbove / createSiblingBelow ────

describe('core.createSiblingAbove / createSiblingBelow', () => {
  it('createSiblingAbove inserts before the sibling under the same parent', async () => {
    await seedABC()
    const id = await env.repo.mutate.createSiblingAbove({siblingId: 'B', id: 'X'})
    expect(await env.childIds('root')).toEqual(['A', id, 'B', 'C'])
  })

  it('createSiblingBelow inserts after the sibling under the same parent', async () => {
    await seedABC()
    const id = await env.repo.mutate.createSiblingBelow({siblingId: 'B', id: 'X'})
    expect(await env.childIds('root')).toEqual(['A', 'B', id, 'C'])
  })

  it('createSiblingBelow at last sibling lands at end', async () => {
    await seedABC()
    const id = await env.repo.mutate.createSiblingBelow({siblingId: 'C', id: 'X'})
    expect(await env.childIds('root')).toEqual(['A', 'B', 'C', id])
  })

  it('createSiblingAbove works on a workspace-root block (parentId = null)', async () => {
    // Two root-level blocks; create a third before r2.
    await env.repo.tx(async tx => {
      await tx.create({id: 'r1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'r2', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    const id = await env.repo.mutate.createSiblingAbove({siblingId: 'r2', id: 'r-above'})
    expect(await env.childIds(null)).toEqual(['r1', id, 'r2'])
  })

  it('createSiblingBelow works on a workspace-root block (parentId = null)', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'r1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'r2', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    const id = await env.repo.mutate.createSiblingBelow({siblingId: 'r1', id: 'r-below'})
    expect(await env.childIds(null)).toEqual(['r1', id, 'r2'])
  })

  it('createSiblingAbove on a root block scopes the sibling lookup to the sibling\'s workspace (no cross-workspace leak)', async () => {
    // ws-1 has r1 at order_key 'a0'.
    // ws-2 has unrelated root rows at order_keys that would otherwise
    // interleave with ws-1's order_key space if the lookup spilled.
    // Pre-fix, the new sibling under ws-1 would be positioned against
    // ws-2's roots, producing an order_key that doesn't sort correctly
    // among ws-1's siblings.
    await env.repo.tx(async tx => {
      await tx.create({id: 'r1', workspaceId: 'ws-1', parentId: null, orderKey: 'a5'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      // Block before r1 in lex order, but in a DIFFERENT workspace.
      await tx.create({id: 'ws2-root-a', workspaceId: 'ws-2', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ws2-root-b', workspaceId: 'ws-2', parentId: null, orderKey: 'a9'})
    }, {scope: ChangeScope.BlockDefault})
    // createSiblingAbove({siblingId:'r1'}) should ONLY see ws-1's
    // siblings — meaning it positions the new row at start of ws-1's
    // root-sibling list (only r1 is there). It must not consider
    // ws-2's rows (which would inject ordering noise).
    const newId = await env.repo.mutate.createSiblingAbove({siblingId: 'r1', id: 'r-above'})
    // ws-1 root rows: new sibling first, then r1.
    const ws1Roots = (await env.h.db.getAll<{id: string}>(
      "SELECT id FROM blocks WHERE workspace_id = ? AND parent_id IS NULL AND deleted = 0 ORDER BY order_key, id",
      ['ws-1'],
    )).map(r => r.id)
    expect(ws1Roots).toEqual([newId, 'r1'])
  })
})

// ──── insertChildren ────

describe('core.insertChildren', () => {
  it('inserts a contiguous run; ids returned in order', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const ids = await env.repo.mutate.insertChildren({
      parentId: 'p',
      items: [{id: 'i1'}, {id: 'i2'}, {id: 'i3'}],
    })
    expect(ids).toEqual(['i1', 'i2', 'i3'])
    expect(await env.childIds('p')).toEqual(['i1', 'i2', 'i3'])
  })

  it('inserts at position={kind:"before", siblingId} preserving sibling adjacency', async () => {
    await seedABC()
    const ids = await env.repo.mutate.insertChildren({
      parentId: 'root',
      items: [{id: 'i1'}, {id: 'i2'}],
      position: {kind: 'before', siblingId: 'B'},
    })
    expect(await env.childIds('root')).toEqual(['A', ids[0], ids[1], 'B', 'C'])
  })

  it('empty items returns empty array, no writes', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const ids = await env.repo.mutate.insertChildren({parentId: 'p', items: []})
    expect(ids).toEqual([])
    expect(await env.childIds('p')).toEqual([])
  })
})

// ──── delete (subtree-aware) ────

describe('core.delete (subtree)', () => {
  it('soft-deletes the block and all its descendants', async () => {
    // root → A → A1 / A2;  root → B
    await seedABC()
    await env.repo.mutate.createChild({parentId: 'A', id: 'A1'})
    await env.repo.mutate.createChild({parentId: 'A', id: 'A2'})
    await env.repo.mutate.createChild({parentId: 'A1', id: 'A1a'})
    // Snapshot pre-delete to ensure all descendants existed.
    expect(env.read('A1')).toBeDefined()
    await env.repo.mutate.delete({id: 'A'})
    for (const id of ['A', 'A1', 'A2', 'A1a']) {
      expect(env.read(id)?.deleted).toBe(true)
    }
    // root + B + C unaffected.
    expect(env.read('root')!.deleted).toBe(false)
    expect(env.read('B')!.deleted).toBe(false)
  })
})

// ──── move ────

describe('core.move', () => {
  it('moves a block to a new parent at position=last', async () => {
    // root → A; root → B; root → C
    await seedABC()
    await env.repo.mutate.move({id: 'C', parentId: 'A', position: {kind: 'last'}})
    expect(env.read('C')!.parentId).toBe('A')
    expect(await env.childIds('A')).toEqual(['C'])
  })

  it('moves to position={kind:"before", siblingId}', async () => {
    await seedABC()
    await env.repo.mutate.move({id: 'C', parentId: 'root', position: {kind: 'before', siblingId: 'A'}})
    expect(await env.childIds('root')).toEqual(['C', 'A', 'B'])
  })

  it('throws ParentDeletedError when target parent is tombstone', async () => {
    await seedABC()
    await env.repo.mutate.delete({id: 'A'})
    await expect(env.repo.mutate.move({id: 'B', parentId: 'A', position: {kind: 'last'}}))
      .rejects.toThrow(ParentDeletedError)
  })

  it('moves a block to root level positioned before an existing root sibling', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'r1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'r2', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'r1', id: 'c1'})
    // Move c1 to root, positioned before r2.
    await env.repo.mutate.move({id: 'c1', parentId: null, position: {kind: 'before', siblingId: 'r2'}})
    expect(await env.childIds(null)).toEqual(['r1', 'c1', 'r2'])
  })
})

// ──── ParentDeletedError — storage-layer enforcement ────

/** The kernel-mutator preflight is a UX convenience; the load-bearing
 *  guarantee is the BEFORE INSERT/UPDATE trigger on `blocks` that fires
 *  for every local write path. These tests pin the bypass cases: raw
 *  `tx.create` / `tx.move` from inside `repo.tx` must surface the same
 *  typed error, and undo of a subtree-delete must replay cleanly. */
describe('ParentDeletedError — storage-layer enforcement', () => {
  it('raw tx.create under a soft-deleted parent throws ParentDeletedError', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.delete({id: 'p'})
    await expect(env.repo.tx(async tx => {
      await tx.create({id: 'c', workspaceId: 'ws-1', parentId: 'p', orderKey: 'b0'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toBeInstanceOf(ParentDeletedError)
  })

  it('raw tx.move onto a soft-deleted parent throws ParentDeletedError', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'q', workspaceId: 'ws-1', parentId: null, orderKey: 'b0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.delete({id: 'p'})
    await expect(env.repo.tx(async tx => {
      await tx.move('q', {parentId: 'p', orderKey: 'c0'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toBeInstanceOf(ParentDeletedError)
  })

  it('raw tx.restore of a tombstoned child whose parent is also tombstoned throws ParentDeletedError', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'c', workspaceId: 'ws-1', parentId: 'p', orderKey: 'b0'})
    }, {scope: ChangeScope.BlockDefault})
    // Soft-delete the child first, then the parent — leaves p and c as
    // separate tombstones. Restoring c alone would re-create a live row
    // under a tombstoned parent, same invariant violation as the
    // insert/move cases.
    await env.repo.tx(async tx => {
      await tx.delete('c')
      await tx.delete('p')
    }, {scope: ChangeScope.BlockDefault})
    await expect(env.repo.tx(async tx => {
      await tx.restore('c')
    }, {scope: ChangeScope.BlockDefault})).rejects.toBeInstanceOf(ParentDeletedError)
  })

  it('undo of a subtree-delete restores the whole subtree without re-triggering', async () => {
    // root → A → A1 → A1a;  root → B → C.  Delete A's subtree, then
    // undo — every tombstone flips back. The trigger fires on each
    // restore-style UPDATE, so this would break if the snapshot map
    // were iterated children-first.
    await seedABC()
    await env.repo.mutate.createChild({parentId: 'A', id: 'A1'})
    await env.repo.mutate.createChild({parentId: 'A1', id: 'A1a'})
    await env.repo.mutate.delete({id: 'A'})
    for (const id of ['A', 'A1', 'A1a']) {
      expect(env.read(id)?.deleted).toBe(true)
    }
    expect(await env.repo.undo()).toBe(true)
    for (const id of ['A', 'A1', 'A1a']) {
      expect(env.read(id)?.deleted).toBe(false)
    }
    expect(env.read('A1')!.parentId).toBe('A')
    expect(env.read('A1a')!.parentId).toBe('A1')
  })
})

// ──── setOrderKey ────

describe('core.setOrderKey', () => {
  it('updates order_key in place under the same parent', async () => {
    await seedABC()
    // Start: A < B < C. Move C to come before A by giving it a key
    // that sorts before A's.
    const A = env.read('A')!
    await env.repo.mutate.setOrderKey({id: 'C', orderKey: '0'})  // base62: '0' < 'A0'
    void A  // referenced only to assert against
    const order = await env.childIds('root')
    expect(order[0]).toBe('C')  // C now first
  })
})

// ──── indent ────

describe('core.indent', () => {
  it('moves the block under its preceding sibling at the end', async () => {
    await seedABC()
    await env.repo.mutate.indent({id: 'B'})
    expect(env.read('B')!.parentId).toBe('A')
    expect(await env.childIds('root')).toEqual(['A', 'C'])
    expect(await env.childIds('A')).toEqual(['B'])
  })

  it('expands the new parent when indenting under a collapsed sibling', async () => {
    await seedABC()
    await env.repo.mutate.setProperty({id: 'A', schema: isCollapsedProp, value: true})

    await env.repo.mutate.indent({id: 'B'})

    expect(env.read('B')!.parentId).toBe('A')
    expect(env.read('A')!.properties[isCollapsedProp.name]).toBe(false)
  })

  it('is a no-op when block has no preceding sibling', async () => {
    await seedABC()
    await env.repo.mutate.indent({id: 'A'})  // first child of root
    expect(env.read('A')!.parentId).toBe('root')
  })

  it('is a no-op for a workspace-root block', async () => {
    // 'root' has parentId = null; indenting is meaningless.
    await env.repo.tx(
      tx => tx.create({id: 'r', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.indent({id: 'r'})
    expect(env.read('r')!.parentId).toBeNull()
  })
})

// ──── outdent ────

describe('core.outdent', () => {
  it('moves a child up under the grandparent right after the parent', async () => {
    // root → A → A1; root → B
    await seedABC()
    const a1 = await env.repo.mutate.createChild({parentId: 'A', id: 'A1'})
    expect(env.read(a1)!.parentId).toBe('A')
    const moved = await env.repo.mutate.outdent({id: 'A1'})
    expect(moved).toBe(true)
    expect(env.read('A1')!.parentId).toBe('root')
    // A1 lands between A and B (post-outdent the order should be A, A1, B, C).
    expect(await env.childIds('root')).toEqual(['A', 'A1', 'B', 'C'])
  })

  it('is a no-op for a workspace-root block', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'r', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const moved = await env.repo.mutate.outdent({id: 'r'})
    expect(moved).toBe(false)
    expect(env.read('r')!.parentId).toBeNull()
  })

  it('refuses to outdent past scopeRootId — direct child stays put', async () => {
    // Without the boundary, A1 (a direct child of A) would normally
    // outdent to root. Passing scopeRootId=A keeps A1 inside.
    await seedABC()
    await env.repo.mutate.createChild({parentId: 'A', id: 'A1'})
    const moved = await env.repo.mutate.outdent({id: 'A1', scopeRootId: 'A'})
    expect(moved).toBe(false)
    expect(env.read('A1')!.parentId).toBe('A')
  })

  it('still outdents a deeper descendant when scopeRootId is set', async () => {
    // A → A1 → A1a; passing scopeRootId=A allows outdent of A1a
    // (since its parent A1 ≠ scopeRootId).
    await seedABC()
    await env.repo.mutate.createChild({parentId: 'A', id: 'A1'})
    await env.repo.mutate.createChild({parentId: 'A1', id: 'A1a'})
    const moved = await env.repo.mutate.outdent({id: 'A1a', scopeRootId: 'A'})
    expect(moved).toBe(true)
    expect(env.read('A1a')!.parentId).toBe('A')
  })
})

// ──── moveVertical ────

describe('core.moveVertical', () => {
  // Shapes the user-facing example:
  //   a / b      (a with child b)
  //   c / d      (c with child d)
  const seedTwoSubtrees = async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'a'})
    await env.repo.mutate.createChild({parentId: 'a', id: 'b'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'c'})
    await env.repo.mutate.createChild({parentId: 'c', id: 'd'})
  }

  it('swaps with the previous sibling (same parent) when one exists', async () => {
    await seedABC()
    const moved = await env.repo.mutate.moveVertical({id: 'B', direction: -1})
    expect(moved).toBe(true)
    expect(await env.childIds('root')).toEqual(['B', 'A', 'C'])
  })

  it('swaps with the next sibling (same parent) when one exists', async () => {
    await seedABC()
    const moved = await env.repo.mutate.moveVertical({id: 'B', direction: 1})
    expect(moved).toBe(true)
    expect(await env.childIds('root')).toEqual(['A', 'C', 'B'])
  })

  it('moves a first child up into the previous sibling subtree at the same depth', async () => {
    // a/b/c, d/e → move e up → e becomes a's last child (depth 1, like
    // it was under d); b keeps its own child c; d is emptied.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'a'})
    await env.repo.mutate.createChild({parentId: 'a', id: 'b'})
    await env.repo.mutate.createChild({parentId: 'b', id: 'c'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'd'})
    await env.repo.mutate.createChild({parentId: 'd', id: 'e'})

    const moved = await env.repo.mutate.moveVertical({id: 'e', direction: -1, scopeRootId: 'root'})
    expect(moved).toBe(true)
    expect(env.read('e')!.parentId).toBe('a')
    expect(await env.childIds('a')).toEqual(['b', 'e'])
    expect(await env.childIds('b')).toEqual(['c'])
    expect(await env.childIds('d')).toEqual([])
  })

  it('moves a last child down into the next sibling subtree (cross-parent)', async () => {
    // a/b, c/d → move b down → b becomes c's first child, a emptied.
    await seedTwoSubtrees()
    const moved = await env.repo.mutate.moveVertical({id: 'b', direction: 1, scopeRootId: 'root'})
    expect(moved).toBe(true)
    expect(env.read('b')!.parentId).toBe('c')
    expect(await env.childIds('c')).toEqual(['b', 'd'])
    expect(await env.childIds('a')).toEqual([])
  })

  it('is a no-op when the parent is itself the first child (would need to outdent)', async () => {
    // root: P/(s); moving s up has no same-depth slot above it without
    // outdenting, so moveVertical leaves it put (indentation invariant).
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'P'})
    await env.repo.mutate.createChild({parentId: 'P', id: 's'})
    const moved = await env.repo.mutate.moveVertical({id: 's', direction: -1})
    expect(moved).toBe(false)
    expect(env.read('s')!.parentId).toBe('P')
    expect(await env.childIds('root')).toEqual(['P'])
  })

  it('descends into AND expands a collapsed previous-sibling subtree (up)', async () => {
    // a (collapsed), c/d → move d up → d becomes a's last child and a is
    // revealed (like indenting under a collapsed bullet), so d stays
    // visible at the same depth.
    await seedTwoSubtrees()
    await env.repo.mutate.setProperty({id: 'a', schema: isCollapsedProp, value: true})
    const moved = await env.repo.mutate.moveVertical({id: 'd', direction: -1, scopeRootId: 'root'})
    expect(moved).toBe(true)
    expect(env.read('d')!.parentId).toBe('a')
    expect(await env.childIds('a')).toEqual(['b', 'd'])
    expect(env.read('a')!.properties[isCollapsedProp.name]).toBe(false)
  })

  it('descends into AND expands a collapsed next-sibling subtree (down)', async () => {
    // a/b, c (collapsed) → move b down → b becomes c's first child and c
    // is revealed.
    await seedTwoSubtrees()
    await env.repo.mutate.setProperty({id: 'c', schema: isCollapsedProp, value: true})
    const moved = await env.repo.mutate.moveVertical({id: 'b', direction: 1, scopeRootId: 'root'})
    expect(moved).toBe(true)
    expect(env.read('b')!.parentId).toBe('c')
    expect(await env.childIds('c')).toEqual(['b', 'd'])
    expect(env.read('c')!.properties[isCollapsedProp.name]).toBe(false)
  })

  it('does not move the scope root itself', async () => {
    await seedTwoSubtrees()
    const moved = await env.repo.mutate.moveVertical({id: 'a', direction: 1, scopeRootId: 'a'})
    expect(moved).toBe(false)
    expect(await env.childIds('root')).toEqual(['a', 'c'])
  })

  it('does not cross a first direct child of the scope root out of scope', async () => {
    // scopeRootId=root-like 'a': 'b' is a's only child; moving it up
    // would escape 'a', so it no-ops.
    await seedTwoSubtrees()
    const moved = await env.repo.mutate.moveVertical({id: 'b', direction: -1, scopeRootId: 'a'})
    expect(moved).toBe(false)
    expect(env.read('b')!.parentId).toBe('a')
  })

  it('without a scopeRootId, the sibling-list edge is a no-op (no unbounded cross-parent)', async () => {
    // a/b, c/d → move d up with NO scope (e.g. a bridge run-action). d is
    // c's first child, so a cross-parent move would need a visible
    // boundary; without one it stays put rather than reparenting.
    await seedTwoSubtrees()
    const moved = await env.repo.mutate.moveVertical({id: 'd', direction: -1})
    expect(moved).toBe(false)
    expect(env.read('d')!.parentId).toBe('c')
  })

  it('still swaps same-parent siblings without a scopeRootId', async () => {
    // Same-parent reorder doesn't need a scope boundary.
    await seedABC()
    const moved = await env.repo.mutate.moveVertical({id: 'B', direction: -1})
    expect(moved).toBe(true)
    expect(await env.childIds('root')).toEqual(['B', 'A', 'C'])
  })
})

// ──── split ────

describe('core.split', () => {
  it('creates a sibling-before with before-text; after-text stays on the original', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const orig = await env.repo.mutate.createChild({parentId: 'p', id: 'orig', content: 'helloworld'})
    void orig
    const newId = await env.repo.mutate.split({id: 'orig', before: 'hello', after: 'world'})
    expect(env.read(newId)!.content).toBe('hello')
    expect(env.read('orig')!.content).toBe('world')
    expect(await env.childIds('p')).toEqual([newId, 'orig'])
  })

  it('empty before creates an empty sibling-before and leaves full content on the original', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'p', id: 'orig', content: 'abc'})
    const newId = await env.repo.mutate.split({id: 'orig', before: '', after: 'abc'})
    expect(env.read(newId)!.content).toBe('')
    expect(env.read('orig')!.content).toBe('abc')
  })

  it('uses caller-supplied text — does not re-slice persisted content', async () => {
    // Ensures the mutator does NOT read self.content for the split. A
    // debounced editor could leave SQL stale; the caller's live before/
    // after is what should land.
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'p', id: 'orig', content: 'stale'})
    const newId = await env.repo.mutate.split({
      id: 'orig',
      before: 'live-prefix',
      after: 'live-suffix',
    })
    expect(env.read(newId)!.content).toBe('live-prefix')
    expect(env.read('orig')!.content).toBe('live-suffix')
  })

  it('leaves existing children attached to the original suffix block', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'p', id: 'orig', content: 'left right'})
    await env.repo.mutate.createChild({parentId: 'orig', id: 'child', content: 'child'})

    const newId = await env.repo.mutate.split({id: 'orig', before: 'left ', after: 'right'})

    expect(await env.childIds('p')).toEqual([newId, 'orig'])
    expect(await env.childIds(newId)).toEqual([])
    expect(await env.childIds('orig')).toEqual(['child'])
    expect(env.read(newId)!.content).toBe('left ')
    expect(env.read('orig')!.content).toBe('right')
  })
})

// ──── merge ────

describe('core.merge', () => {
  it('concatenates content into target and soft-deletes source', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'p', id: 'a', content: 'hello'})
    await env.repo.mutate.createChild({parentId: 'p', id: 'b', content: 'world'})
    await env.repo.mutate.merge({intoId: 'a', fromId: 'b'})
    expect(env.read('a')!.content).toBe('helloworld')
    expect(env.read('b')!.deleted).toBe(true)
    expect(await env.childIds('p')).toEqual(['a'])
  })

  it("re-parents source's children under the target so they aren't stranded", async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'p', id: 'a', content: 'A:'})
    await env.repo.mutate.createChild({parentId: 'p', id: 'b', content: 'B:'})
    await env.repo.mutate.createChild({parentId: 'b', id: 'b1', content: 'b1'})
    await env.repo.mutate.createChild({parentId: 'b', id: 'b2', content: 'b2'})
    await env.repo.mutate.merge({intoId: 'a', fromId: 'b'})
    // a's content concatenated, a inherits b's children.
    expect(env.read('a')!.content).toBe('A:B:')
    expect(await env.childIds('a')).toEqual(['b1', 'b2'])
    // b is soft-deleted but its row persists in storage; children point
    // at 'a' now.
    expect(env.read('b')!.deleted).toBe(true)
    for (const id of ['b1', 'b2']) {
      expect(env.read(id)!.parentId).toBe('a')
      expect(env.read(id)!.deleted).toBe(false)
    }
  })

  it('emits a same-tx block-merged event after applying core merge effects', async () => {
    const events: CoreBlockMergedEvent[] = []
    env.repo.__setSameTxProcessorsForTesting([
      {
        name: 'test.mergeObserver',
        watches: {kind: 'event', events: [CORE_BLOCK_MERGED_EVENT]},
        apply: async (event) => {
          events.push(...event.emittedEvents.map(e => e.payload as CoreBlockMergedEvent))
        },
      },
    ])

    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'p', id: 'a', content: 'A'})
    await env.repo.mutate.createChild({parentId: 'p', id: 'b', content: 'B'})
    await env.repo.mutate.merge({intoId: 'a', fromId: 'b', contentStrategy: 'keepTarget'})

    expect(events).toEqual([{
      workspaceId: 'ws-1',
      fromId: 'b',
      intoId: 'a',
      aliasRewrites: [],
    }])
    expect(env.read('a')!.content).toBe('A')
    expect(env.read('b')!.deleted).toBe(true)
  })

  describe('contentStrategy', () => {
    const seed = async (intoContent: string, fromContent: string) => {
      await env.repo.tx(
        tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )
      await env.repo.mutate.createChild({parentId: 'p', id: 'into', content: intoContent})
      await env.repo.mutate.createChild({parentId: 'p', id: 'from', content: fromContent})
    }

    it("defaults to 'concat' (Backspace-at-start caller stays identical)", async () => {
      await seed('foo', 'bar')
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from'})
      expect(env.read('into')!.content).toBe('foobar')
    })

    it("'concat' joins with empty string", async () => {
      await seed('foo', 'bar')
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from', contentStrategy: 'concat'})
      expect(env.read('into')!.content).toBe('foobar')
    })

    it("'keepTarget' keeps target content when non-empty", async () => {
      await seed('canonical text', 'will be discarded')
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from', contentStrategy: 'keepTarget'})
      expect(env.read('into')!.content).toBe('canonical text')
    })

    it("'keepTarget' takes source content when target is empty (stub absorbs page)", async () => {
      await seed('', 'real writeup')
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from', contentStrategy: 'keepTarget'})
      expect(env.read('into')!.content).toBe('real writeup')
    })

    it('{separator} joins with the given separator', async () => {
      await seed('line one', 'line two')
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from', contentStrategy: {separator: '\n'}})
      expect(env.read('into')!.content).toBe('line one\nline two')
    })
  })

  describe('property merge', () => {
    const seedWithProps = async (
      intoProps: Record<string, unknown>,
      fromProps: Record<string, unknown>,
    ) => {
      await env.repo.tx(
        tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )
      await env.repo.mutate.createChild({parentId: 'p', id: 'into', properties: intoProps})
      await env.repo.mutate.createChild({parentId: 'p', id: 'from', properties: fromProps})
    }

    it('unions array-typed properties (target order first)', async () => {
      await seedWithProps(
        {tags: ['x', 'y']},
        {tags: ['y', 'z']},
      )
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from'})
      expect(env.read('into')!.properties.tags).toEqual(['x', 'y', 'z'])
    })

    it('takes source-only properties through to the target', async () => {
      await seedWithProps({a: 1}, {b: 2})
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from'})
      expect(env.read('into')!.properties).toMatchObject({a: 1, b: 2})
    })

    it('target wins on scalar collision', async () => {
      await seedWithProps({title: 'Target'}, {title: 'Source'})
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from'})
      expect(env.read('into')!.properties.title).toBe('Target')
    })

    it('merges alias arrays without tripping the uniqueness trigger', async () => {
      // Each page-block's title is conventionally its own alias. After
      // merge, target should carry both titles so wikilinks resolve.
      // The unique trigger fires per-row; if we leave source's alias in
      // place when writing target's merged properties, this rejects.
      await seedWithProps(
        {[aliasesProp.name]: aliasesProp.codec.encode(['Foo'])},
        {[aliasesProp.name]: aliasesProp.codec.encode(['Bar'])},
      )
      await env.repo.mutate.merge({intoId: 'into', fromId: 'from'})
      expect(env.read('into')!.properties[aliasesProp.name]).toEqual(['Foo', 'Bar'])
      expect(env.read('from')!.deleted).toBe(true)
    })
  })
})

// ──── dispatch surface ────

describe('repo.mutate / repo.run dispatch', () => {
  it('repo.mutate.<short> resolves to core.<short> for kernel mutators', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'd1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'pre'}),
      {scope: ChangeScope.BlockDefault},
    )
    // Both forms work; same registered mutator.
    await env.repo.mutate.setContent({id: 'd1', content: 'short'})
    expect(env.read('d1')!.content).toBe('short')
    await (env.repo.mutate as Record<string, (a: unknown) => Promise<unknown>>)['core.setContent']({id: 'd1', content: 'full'})
    expect(env.read('d1')!.content).toBe('full')
  })

  it('repo.run("core.setContent", args) is the dynamic equivalent', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'd2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.run('core.setContent', {id: 'd2', content: 'via run'})
    expect(env.read('d2')!.content).toBe('via run')
  })

  it('throws MutatorNotRegisteredError for an unknown name', async () => {
    await expect(env.repo.run('plugin:nope', {id: 'x'})).rejects.toThrow(/no mutator registered/)
  })

  it('argsSchema is enforced — invalid args reject before any tx opens', async () => {
    await expect(
      env.repo.mutate.setContent({id: 1, content: 'x'} as unknown as {id: string; content: string}),
    ).rejects.toThrow()
  })

  it('repo.mutate.<name> records the call into command_events.mutator_calls', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'mc1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.setContent({id: 'mc1', content: 'recorded'})

    const calls = await env.h.db.getAll<{mutator_calls: string; description: string | null}>(
      "SELECT mutator_calls, description FROM command_events ORDER BY created_at DESC LIMIT 1",
    )
    const parsed = JSON.parse(calls[0].mutator_calls) as Array<{name: string; args: unknown}>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual({name: 'core.setContent', args: {id: 'mc1', content: 'recorded'}})
    // describe also lands in command_events.description.
    expect(calls[0].description).toBe('set content on mc1')
  })

  it('a composed mutator (mutator-runs-mutator via tx.run) records every step in mutator_calls', async () => {
    // delete recursively walks the subtree and calls tx.delete via
    // softDeleteSubtree, but those are tx primitives — not mutator
    // calls. So delete itself is one entry. setContent is one entry.
    // To verify composition we need a mutator that calls tx.run.
    // Easier: do two top-level mutator calls in one repo.tx via a raw
    // call — the dispatch wrapper opens its own tx so composition has
    // to happen inside a single tx.run boundary. We test composition
    // by calling raw `repo.tx` with two `tx.run`s.
    await env.repo.tx(
      tx => tx.create({id: 'mc2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(async tx => {
      // Simulate a composed scenario: two mutator runs in one tx.
      const setContentMutator = (
        env.repo as unknown as {mutators: Map<string, {apply: (tx: unknown, args: unknown) => Promise<unknown>; name: string; argsSchema: unknown; scope: unknown}>}
      ).mutators.get('core.setContent')!
      // The exposed `tx.run` accepts the registered mutator object.
      await tx.run(setContentMutator as never, {id: 'mc2', content: 'first'})
      await tx.run(setContentMutator as never, {id: 'mc2', content: 'second'})
    }, {scope: ChangeScope.BlockDefault})

    const last = await env.h.db.getAll<{mutator_calls: string}>(
      "SELECT mutator_calls FROM command_events ORDER BY created_at DESC LIMIT 1",
    )
    const parsed = JSON.parse(last[0].mutator_calls) as Array<{name: string; args: unknown}>
    expect(parsed).toHaveLength(2)
    expect(parsed.map(c => c.name)).toEqual(['core.setContent', 'core.setContent'])
    expect((parsed[0].args as {content: string}).content).toBe('first')
    expect((parsed[1].args as {content: string}).content).toBe('second')
  })

  it('raw repo.tx with no tx.run records mutator_calls = []', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'mc3', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault, description: 'raw create'},
    )
    const last = await env.h.db.getAll<{mutator_calls: string; description: string | null}>(
      "SELECT mutator_calls, description FROM command_events ORDER BY created_at DESC LIMIT 1",
    )
    expect(JSON.parse(last[0].mutator_calls)).toEqual([])
    expect(last[0].description).toBe('raw create')
  })

  it('rollback discards mutator_calls — no command_events row written', async () => {
    const before = await env.h.db.getAll('SELECT tx_id FROM command_events')
    await expect(env.repo.tx(async tx => {
      const m = (
        env.repo as unknown as {mutators: Map<string, {apply: (tx: unknown, args: unknown) => Promise<unknown>; name: string; argsSchema: unknown; scope: unknown}>}
      ).mutators.get('core.setContent')!
      await tx.run(m as never, {id: 'no-such', content: 'x'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow()
    const after = await env.h.db.getAll('SELECT tx_id FROM command_events')
    expect(after.length).toBe(before.length)
  })
})
