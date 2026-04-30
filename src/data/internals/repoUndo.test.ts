// @vitest-environment node
/**
 * Integration tests for `repo.undo()` / `repo.redo()` (spec §10 step 7,
 * §17 line 2228). Runs against a real PowerSyncDatabase via
 * `createTestDb` so triggers fire correctly and SQL state matches what
 * the production app would observe.
 *
 * Coverage:
 *   - Round-trip: setContent → undo reverts → redo re-applies
 *   - Round-trip: create → undo soft-deletes → redo restores
 *   - Round-trip: tx.delete → undo restores (deleted=0) → redo deletes
 *   - Round-trip: move → undo reverts parent/order → redo re-moves
 *   - Multi-row tx (kernel mutator): one entry covers all rows
 *   - Stack discipline: a new tx after undo clears the redo branch
 *   - Read-only mode rejects undo (BlockDefault scope)
 *   - UiState writes never enter the undo stack
 *   - References scope is recorded but isolated from BlockDefault
 *   - Empty stack: undo / redo return false (no-op)
 *   - Replay tx tags `source = 'user'` so the inverse uploads — verified
 *     by checking ps_crud row count grew after the undo replay
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, ReadOnlyError } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'

const WS = 'ws-1'

interface Harness {
  h: TestDb
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
    // Disable kernel processors so parseReferences doesn't fire and
    // add its own tx entries during these tests — keeps the audited
    // stack predictable.
    registerKernelProcessors: false,
  })
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
  // Clear undo history so each test starts with an empty stack —
  // seed isn't part of what we're undoing.
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

const isDeleted = async (repo: Repo, id: string): Promise<boolean> => {
  const row = await repo.db.getOptional<{deleted: number}>(
    'SELECT deleted FROM blocks WHERE id = ?',
    [id],
  )
  return row?.deleted === 1
}

const rowCount = async (repo: Repo, table: string): Promise<number> => {
  const row = await repo.db.get<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`)
  return row.n
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('repo.undo / redo on tx.update (setContent)', () => {
  it('reverts content on undo and re-applies on redo', async () => {
    await seedRoot(env.repo, 'a', 'original')

    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})
    expect(await readContent(env.repo, 'a')).toBe('edited')

    expect(await env.repo.undo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('original')

    expect(await env.repo.redo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('edited')

    // Roundtrip again — confirms entry shuttles symmetrically
    expect(await env.repo.undo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('original')
  })
})

describe('repo.undo / redo on tx.create', () => {
  it('undoes a create by soft-deleting and redoes by restoring the row', async () => {
    await env.repo.tx(async (tx) => {
      await tx.create({
        id: 'fresh',
        workspaceId: WS,
        parentId: null,
        orderKey: 'b0',
        content: 'created',
      })
    }, {scope: ChangeScope.BlockDefault})
    expect(await isDeleted(env.repo, 'fresh')).toBe(false)

    expect(await env.repo.undo()).toBe(true)
    expect(await isDeleted(env.repo, 'fresh')).toBe(true)

    expect(await env.repo.redo()).toBe(true)
    expect(await isDeleted(env.repo, 'fresh')).toBe(false)
    expect(await readContent(env.repo, 'fresh')).toBe('created')
  })
})

describe('repo.undo / redo on tx.delete', () => {
  it('undoes a soft-delete by restoring and redoes by re-soft-deleting', async () => {
    await seedRoot(env.repo, 'doomed', 'live')

    await env.repo.tx(async (tx) => {
      await tx.delete('doomed')
    }, {scope: ChangeScope.BlockDefault})
    expect(await isDeleted(env.repo, 'doomed')).toBe(true)

    expect(await env.repo.undo()).toBe(true)
    expect(await isDeleted(env.repo, 'doomed')).toBe(false)
    expect(await readContent(env.repo, 'doomed')).toBe('live')

    expect(await env.repo.redo()).toBe(true)
    expect(await isDeleted(env.repo, 'doomed')).toBe(true)
  })
})

describe('repo.undo / redo on tx.move', () => {
  it('reverts parent + order_key on undo and re-applies on redo', async () => {
    // Build a 3-block tree: parent1, parent2, child (under parent1).
    await env.repo.tx(async (tx) => {
      await tx.create({id: 'p1', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'p2', workspaceId: WS, parentId: null, orderKey: 'a1'})
      await tx.create({id: 'kid', workspaceId: WS, parentId: 'p1', orderKey: 'b0'})
    }, {scope: ChangeScope.BlockDefault, description: 'seed tree'})
    env.repo.undoManager.clear()

    await env.repo.tx(async (tx) => {
      await tx.move('kid', {parentId: 'p2', orderKey: 'c0'})
    }, {scope: ChangeScope.BlockDefault, description: 'move kid'})

    let row = await env.repo.db.get<{parent_id: string; order_key: string}>(
      'SELECT parent_id, order_key FROM blocks WHERE id = ?',
      ['kid'],
    )
    expect(row.parent_id).toBe('p2')
    expect(row.order_key).toBe('c0')

    expect(await env.repo.undo()).toBe(true)
    row = await env.repo.db.get('SELECT parent_id, order_key FROM blocks WHERE id = ?', ['kid'])
    expect(row.parent_id).toBe('p1')
    expect(row.order_key).toBe('b0')

    expect(await env.repo.redo()).toBe(true)
    row = await env.repo.db.get('SELECT parent_id, order_key FROM blocks WHERE id = ?', ['kid'])
    expect(row.parent_id).toBe('p2')
    expect(row.order_key).toBe('c0')
  })
})

describe('repo.undo on a multi-row tx', () => {
  it('reverts every row touched in one tx as a single undo step', async () => {
    await seedRoot(env.repo, 'a', 'A0')
    await seedRoot(env.repo, 'b', 'B0')

    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'A1'})
      await tx.update('b', {content: 'B1'})
    }, {scope: ChangeScope.BlockDefault, description: 'multi'})

    expect(await readContent(env.repo, 'a')).toBe('A1')
    expect(await readContent(env.repo, 'b')).toBe('B1')

    expect(await env.repo.undo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('A0')
    expect(await readContent(env.repo, 'b')).toBe('B0')

    // Redo restores the multi-row state in one step
    expect(await env.repo.redo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('A1')
    expect(await readContent(env.repo, 'b')).toBe('B1')
  })
})

describe('redo branch invalidation', () => {
  it('clears the redo stack when a new tx commits after an undo', async () => {
    await seedRoot(env.repo, 'a', 'v0')

    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'v1'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.undo()

    // A new edit branches off pre-v1 — redo of v1 must no longer be
    // reachable
    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'v2'})
    }, {scope: ChangeScope.BlockDefault})

    expect(await env.repo.redo()).toBe(false)
    expect(await readContent(env.repo, 'a')).toBe('v2')
  })
})

describe('repo.undo in read-only mode', () => {
  it('rejects with ReadOnlyError on a BlockDefault entry', async () => {
    await seedRoot(env.repo, 'a', 'live')
    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault})

    env.repo.setReadOnly(true)
    await expect(env.repo.undo()).rejects.toBeInstanceOf(ReadOnlyError)

    // Entry was pushed back so user can retry once read-only flips
    env.repo.setReadOnly(false)
    expect(await env.repo.undo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('live')
  })
})

describe('UiState writes are not undoable', () => {
  it('never push onto the undo stack', async () => {
    await seedRoot(env.repo, 'a')

    await env.repo.tx(async (tx) => {
      await tx.update('a', {properties: {focused: 'true'}})
    }, {scope: ChangeScope.UiState})

    expect(env.repo.undoManager.depths(ChangeScope.BlockDefault)).toEqual({undo: 0, redo: 0})
    expect(env.repo.undoManager.depths(ChangeScope.UiState)).toEqual({undo: 0, redo: 0})
    expect(await env.repo.undo()).toBe(false)
  })
})

describe('References scope', () => {
  it('records into a separate stack — does not affect BlockDefault undo', async () => {
    await seedRoot(env.repo, 'a', 'live')

    // BlockDefault tx
    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault})

    // References tx (e.g. parseReferences-style bookkeeping)
    await env.repo.tx(async (tx) => {
      await tx.update('a', {references: [{id: 'a', alias: 'self'}]})
    }, {scope: ChangeScope.References})

    // BlockDefault undo pops the BlockDefault entry, leaving References
    // stack untouched.
    expect(await env.repo.undo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('live')
    expect(env.repo.undoManager.depths(ChangeScope.References).undo).toBe(1)
  })
})

describe('repo.undo / redo on empty stack', () => {
  it('returns false when there is nothing to undo / redo', async () => {
    expect(await env.repo.undo()).toBe(false)
    expect(await env.repo.redo()).toBe(false)
  })
})

describe('undo replay uploads (source = user)', () => {
  it('writes to ps_crud just like the original tx did', async () => {
    await seedRoot(env.repo, 'a', 'v0')
    const baseline = await rowCount(env.repo, 'ps_crud')

    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'v1'})
    }, {scope: ChangeScope.BlockDefault})
    const afterEdit = await rowCount(env.repo, 'ps_crud')
    expect(afterEdit).toBeGreaterThan(baseline)

    await env.repo.undo()
    const afterUndo = await rowCount(env.repo, 'ps_crud')
    // Undo must produce its own ps_crud row(s) so the inverse syncs.
    expect(afterUndo).toBeGreaterThan(afterEdit)
  })
})
