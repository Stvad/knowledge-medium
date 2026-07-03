// @vitest-environment node
/**
 * Integration tests for `repo.undoGroup()` — merge-at-record undo
 * grouping (issue #306). Runs against a real PowerSyncDatabase via
 * `createTestDb` so the group token round-trips through the commit
 * pipeline (`tx_context.group_id`) and the row_events triggers.
 *
 * Behavioral invariants covered (issue #306):
 *   1. N transactions under one group → a single undo entry whose undo
 *      reverts all their writes (and redo re-applies them)
 *   3. Create-then-update inside a group → undo removes the block
 *      (inverse-of-create path)
 *   4. A foreign tx between grouped txs splits the group; undoing the
 *      top group entry leaves the foreign write untouched
 *   5. A merged record clears the redo stack; `depths()` reports 1
 *   6. `grouped.mutate.X(...)` joins the group
 *   7. Ungrouped txs behave exactly as before (regression)
 *   8. Partial failure mid-group → one entry covering the committed
 *      prefix; the error propagates
 *   9. Nested `undoGroup` joins the outer group
 *  10. `row_events.group_id` carries the group token for grouped txs
 *      and NULL for ungrouped ones (sync-apply NULL is pinned in
 *      clientSchema.test.ts at the trigger level)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '../repo'

const WS = 'ws-1'
const SCOPE = {scope: ChangeScope.BlockDefault}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const {repo} = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

const seedRoot = async (repo: Repo, id: string, content = '') => {
  await repo.tx(async (tx) => {
    await tx.create({
      id,
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content,
    })
  }, {scope: ChangeScope.BlockDefault, description: `seed ${id}`})
  repo.undoManager.clear()
}

const readContent = async (repo: Repo, id: string): Promise<string | null> => {
  const row = await repo.db.getOptional<{content: string; deleted: number}>(
    'SELECT content, deleted FROM blocks WHERE id = ?',
    [id],
  )
  if (row === null) return null
  return row.deleted === 1 ? null : row.content
}

const depths = (repo: Repo) => repo.undoManager.depths(ChangeScope.BlockDefault)

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

describe('repo.undoGroup — single entry, full revert (invariant 1)', () => {
  it('folds N grouped txs into one entry; undo reverts all writes, redo re-applies', async () => {
    const {repo} = env
    await seedRoot(repo, 'x', 'x-original')

    await repo.undoGroup(async (grouped) => {
      await grouped.tx(async (tx) => {
        await tx.create({id: 'g-a', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'a-created'})
      }, SCOPE)
      await grouped.tx(async (tx) => {
        await tx.update('x', {content: 'x-edited'})
      }, SCOPE)
      await grouped.tx(async (tx) => {
        await tx.update('g-a', {content: 'a-edited'})
      }, SCOPE)
    })

    expect(depths(repo)).toEqual({undo: 1, redo: 0})

    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'x')).toBe('x-original')
    expect(await readContent(repo, 'g-a')).toBeNull() // create undone → soft-deleted
    expect(depths(repo)).toEqual({undo: 0, redo: 1})

    expect(await repo.redo()).toBe(true)
    expect(await readContent(repo, 'x')).toBe('x-edited')
    expect(await readContent(repo, 'g-a')).toBe('a-edited')
  })

  it('returns the callback result', async () => {
    const {repo} = env
    const result = await repo.undoGroup(async () => 42)
    expect(result).toBe(42)
  })
})

describe('create-then-update folding (invariant 3)', () => {
  it('undo removes a block that was created then updated inside the group', async () => {
    const {repo} = env
    await repo.undoGroup(async (grouped) => {
      await grouped.tx(async (tx) => {
        await tx.create({id: 'c1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'v1'})
      }, SCOPE)
      await grouped.tx(async (tx) => {
        await tx.update('c1', {content: 'v2'})
      }, SCOPE)
    })

    expect(depths(repo)).toEqual({undo: 1, redo: 0})
    expect(await repo.undo()).toBe(true)
    // Earliest `before` is null (created in the group) → the undo path is
    // the inverse-of-create: the block is gone, not reverted to 'v1'.
    expect(await readContent(repo, 'c1')).toBeNull()

    expect(await repo.redo()).toBe(true)
    expect(await readContent(repo, 'c1')).toBe('v2')
  })
})

describe('foreign tx splits the group (invariant 4)', () => {
  it('keeps the foreign write out of the group; undo peels entries in order', async () => {
    const {repo} = env
    await seedRoot(repo, 'grouped-target', 'g0')
    await seedRoot(repo, 'foreign-target', 'f0')

    await repo.undoGroup(async (grouped) => {
      await grouped.tx(async (tx) => {
        await tx.update('grouped-target', {content: 'g1'})
      }, SCOPE)
      // A tx on the PLAIN repo (not the grouped facade) — e.g. a
      // background write landing mid-group.
      await repo.tx(async (tx) => {
        await tx.update('foreign-target', {content: 'f1'})
      }, SCOPE)
      await grouped.tx(async (tx) => {
        await tx.update('grouped-target', {content: 'g2'})
      }, SCOPE)
    })

    // [group-first-half, foreign, group-second-half]
    expect(depths(repo)).toEqual({undo: 3, redo: 0})

    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'grouped-target')).toBe('g1')
    expect(await readContent(repo, 'foreign-target')).toBe('f1') // untouched

    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'foreign-target')).toBe('f0')
    expect(await readContent(repo, 'grouped-target')).toBe('g1')

    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'grouped-target')).toBe('g0')
  })
})

describe('merge clears redo (invariant 5)', () => {
  it('a merged record invalidates the redo branch', async () => {
    const {repo} = env
    await seedRoot(repo, 'a', 'a0')
    await seedRoot(repo, 'b', 'b0')

    await repo.undoGroup(async (grouped) => {
      await grouped.tx(async (tx) => {
        await tx.update('a', {content: 'a1'})
      }, SCOPE)
      // Foreign tx lands and is undone — leaves it on the redo stack
      // while the group entry is back on top of undo.
      await repo.tx(async (tx) => {
        await tx.update('b', {content: 'b1'})
      }, SCOPE)
      expect(await repo.undo()).toBe(true)
      expect(depths(repo)).toEqual({undo: 1, redo: 1})

      // Next grouped tx merges into the top entry AND clears redo.
      await grouped.tx(async (tx) => {
        await tx.update('a', {content: 'a2'})
      }, SCOPE)
    })

    expect(depths(repo)).toEqual({undo: 1, redo: 0})
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('a0')
    expect(await readContent(repo, 'b')).toBe('b0') // b1 was undone; redo branch dropped
  })
})

describe('grouped.mutate joins the group (invariant 6)', () => {
  it('a kernel mutator dispatched through the facade merges into the group entry', async () => {
    const {repo} = env
    await repo.undoGroup(async (grouped) => {
      await grouped.tx(async (tx) => {
        await tx.create({id: 'm1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'v1'})
      }, SCOPE)
      await grouped.mutate.setContent({id: 'm1', content: 'v2'})
    })

    expect(depths(repo)).toEqual({undo: 1, redo: 0})
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'm1')).toBeNull() // whole group reverted
  })

  it('grouped.run joins the group too (dynamic dispatch)', async () => {
    const {repo} = env
    await seedRoot(repo, 'r1', 'v0')
    await repo.undoGroup(async (grouped) => {
      await grouped.run('core.setContent', {id: 'r1', content: 'v1'})
      await grouped.run('setContent', {id: 'r1', content: 'v2'}) // core-prefix shortcut
    })

    expect(depths(repo)).toEqual({undo: 1, redo: 0})
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'r1')).toBe('v0')
  })
})

describe('ungrouped txs unchanged (invariant 7 — regression)', () => {
  it('two plain txs still record two separate entries', async () => {
    const {repo} = env
    await seedRoot(repo, 'p', 'v0')
    await repo.tx(async (tx) => { await tx.update('p', {content: 'v1'}) }, SCOPE)
    await repo.tx(async (tx) => { await tx.update('p', {content: 'v2'}) }, SCOPE)

    expect(depths(repo)).toEqual({undo: 2, redo: 0})
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'p')).toBe('v1')
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'p')).toBe('v0')
  })
})

describe('partial failure mid-group (invariant 8)', () => {
  it('keeps one entry covering the committed prefix and propagates the error', async () => {
    const {repo} = env
    await expect(repo.undoGroup(async (grouped) => {
      await grouped.tx(async (tx) => {
        await tx.create({id: 'pf1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'committed'})
      }, SCOPE)
      await grouped.tx(async (tx) => {
        await tx.update('pf1', {content: 'rolled-back'})
        throw new Error('boom')
      }, SCOPE)
    })).rejects.toThrow('boom')

    // The failed tx rolled back and was never recorded; the group entry
    // covers exactly the committed prefix.
    expect(await readContent(repo, 'pf1')).toBe('committed')
    expect(depths(repo)).toEqual({undo: 1, redo: 0})
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'pf1')).toBeNull()
  })
})

describe('nested undoGroup joins the outer group (invariant 9)', () => {
  it('inner undoGroup txs merge into the outer entry', async () => {
    const {repo} = env
    await repo.undoGroup(async (outer) => {
      await outer.tx(async (tx) => {
        await tx.create({id: 'n1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'outer'})
      }, SCOPE)
      await outer.undoGroup(async (inner) => {
        await inner.tx(async (tx) => {
          await tx.create({id: 'n2', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'inner'})
        }, SCOPE)
      })
    })

    expect(depths(repo)).toEqual({undo: 1, redo: 0})
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'n1')).toBeNull()
    expect(await readContent(repo, 'n2')).toBeNull()
  })
})

describe('row_events.group_id persistence (invariant 10)', () => {
  it('stamps every grouped tx row with the shared group id; ungrouped rows stay NULL', async () => {
    const {repo} = env
    await seedRoot(repo, 'seeded', 'v0') // ungrouped write → NULL group_id

    await repo.undoGroup(async (grouped) => {
      await grouped.tx(async (tx) => {
        await tx.create({id: 'ge1', workspaceId: WS, parentId: null, orderKey: 'b0', content: ''})
      }, SCOPE)
      await grouped.tx(async (tx) => {
        await tx.update('ge1', {content: 'edited'})
      }, SCOPE)
    })

    const rows = await repo.db.getAll<{tx_id: string | null; group_id: string | null; block_id: string}>(
      'SELECT tx_id, group_id, block_id FROM row_events ORDER BY id',
    )
    const grouped = rows.filter(r => r.group_id !== null)
    const ungrouped = rows.filter(r => r.group_id === null)

    // Both grouped txs share one token; their rows span 2 distinct tx_ids.
    expect(grouped.length).toBeGreaterThanOrEqual(2)
    expect(new Set(grouped.map(r => r.group_id)).size).toBe(1)
    expect(new Set(grouped.map(r => r.tx_id)).size).toBe(2)
    // The seed write is ungrouped.
    expect(ungrouped.some(r => r.block_id === 'seeded')).toBe(true)
    expect(grouped.every(r => r.block_id === 'ge1')).toBe(true)
  })
})
