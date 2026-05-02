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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, ParentDeletedError, codecs, defineProperty, type BlockData } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'

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
    // Mutator tests assert on user-facing tx side-effects (cache,
    // command_events). Kernel processors firing add follow-up txs
    // that aren't under test here; integration coverage lives in
    // parseReferencesProcessor.test.ts.
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

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

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
    kind: 'string',
  })

  const uiFlagProp = defineProperty<boolean>('ui:flag', {
    codec: codecs.boolean,
    defaultValue: false,
    changeScope: ChangeScope.UiState,
    kind: 'boolean',
  })

  it('encodes the value via codec and stores under properties[name]', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.setProperty({id: 'p1', schema: titleProp, value: 'Hello'})
    expect(env.read('p1')!.properties.title).toBe('Hello')
  })

  it('derives tx scope from schema.changeScope: a UiState property writes as local-ephemeral', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.setProperty({id: 'p2', schema: uiFlagProp, value: true})
    // Inspect command_events for the second tx; it should be tagged
    // with scope=UiState and source=local-ephemeral, NOT BlockDefault/user.
    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events ORDER BY created_at',
    )
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({scope: ChangeScope.UiState, source: 'local-ephemeral'})
  })

  it('UiState property writes are allowed in read-only mode (where BlockDefault writes throw)', async () => {
    // Pre-seed a target row in a regular repo so the read-only repo
    // has something to write to.
    await env.repo.tx(
      tx => tx.create({id: 'p3', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const ro = await import('./repo').then(m => new m.Repo({
      db: env.h.db,
      cache: env.cache,
      user: {id: 'user-1', name: 'Test'},
      isReadOnly: true,
    }))
    // BlockDefault throws ReadOnlyError; UiState passes through.
    await expect(
      ro.mutate.setProperty({id: 'p3', schema: titleProp, value: 'no'}),
    ).rejects.toThrow(/read.?only/i)
    await ro.mutate.setProperty({id: 'p3', schema: uiFlagProp, value: true})
    // Local-ephemeral source so it didn't enter the upload queue.
    const ephemeral = await env.h.db.getAll<{source: string}>(
      "SELECT source FROM command_events WHERE scope = 'local-ui'",
    )
    expect(ephemeral.every(e => e.source === 'local-ephemeral')).toBe(true)
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

  it('refuses to outdent past topLevelBlockId — direct child stays put', async () => {
    // Without the boundary, A1 (a direct child of A) would normally
    // outdent to root. Passing topLevelBlockId=A keeps A1 inside.
    await seedABC()
    await env.repo.mutate.createChild({parentId: 'A', id: 'A1'})
    const moved = await env.repo.mutate.outdent({id: 'A1', topLevelBlockId: 'A'})
    expect(moved).toBe(false)
    expect(env.read('A1')!.parentId).toBe('A')
  })

  it('still outdents a deeper descendant when topLevelBlockId is set', async () => {
    // A → A1 → A1a; passing topLevelBlockId=A allows outdent of A1a
    // (since its parent A1 ≠ topLevelBlockId).
    await seedABC()
    await env.repo.mutate.createChild({parentId: 'A', id: 'A1'})
    await env.repo.mutate.createChild({parentId: 'A1', id: 'A1a'})
    const moved = await env.repo.mutate.outdent({id: 'A1a', topLevelBlockId: 'A'})
    expect(moved).toBe(true)
    expect(env.read('A1a')!.parentId).toBe('A')
  })
})

// ──── split ────

describe('core.split', () => {
  it('keeps before-text on the original; after-text lives on a new sibling-after', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const orig = await env.repo.mutate.createChild({parentId: 'p', id: 'orig', content: 'helloworld'})
    void orig
    const newId = await env.repo.mutate.split({id: 'orig', before: 'hello', after: 'world'})
    expect(env.read('orig')!.content).toBe('hello')
    expect(env.read(newId)!.content).toBe('world')
    expect(await env.childIds('p')).toEqual(['orig', newId])
  })

  it('empty before leaves the original empty and full content goes to the new sibling', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'p', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.mutate.createChild({parentId: 'p', id: 'orig', content: 'abc'})
    const newId = await env.repo.mutate.split({id: 'orig', before: '', after: 'abc'})
    expect(env.read('orig')!.content).toBe('')
    expect(env.read(newId)!.content).toBe('abc')
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
    expect(env.read('orig')!.content).toBe('live-prefix')
    expect(env.read(newId)!.content).toBe('live-suffix')
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
