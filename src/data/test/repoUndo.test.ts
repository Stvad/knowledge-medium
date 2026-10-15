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
 *   - A tx committing mid-gesture: the stacks follow commit order (#227)
 *   - Read-only mode rejects undo (BlockDefault scope)
 *   - UiState/UserPrefs writes never enter the undo stack
 *   - References scope is recorded but isolated from BlockDefault
 *   - Empty stack: undo / redo return false (no-op)
 *   - Replay tx tags `source = 'user'` so the inverse uploads — verified
 *     by checking ps_crud row count grew after the undo replay
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, ReadOnlyError } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import { aliasesProp } from '@/data/properties'
import { Repo } from '../repo'
import type { HistoryDrop } from '@/data/internals/undoManager'
import { TxImpl } from '@/data/internals/txEngine'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const {repo} = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
  })
  // Undo / redo are scoped to the active workspace (issue #186); pin it
  // to WS so the default-workspace edits below are the cmd-Z target.
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

const rowCount = async (repo: Repo, table: string): Promise<number> => {
  const row = await repo.db.get<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`)
  return row.n
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

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
    expect(await isBlockDeleted(env.repo, 'fresh')).toBe(false)

    expect(await env.repo.undo()).toBe(true)
    expect(await isBlockDeleted(env.repo, 'fresh')).toBe(true)

    expect(await env.repo.redo()).toBe(true)
    expect(await isBlockDeleted(env.repo, 'fresh')).toBe(false)
    expect(await readContent(env.repo, 'fresh')).toBe('created')
  })
})

describe('repo.undo / redo on tx.delete', () => {
  it('undoes a soft-delete by restoring and redoes by re-soft-deleting', async () => {
    await seedRoot(env.repo, 'doomed', 'live')

    await env.repo.tx(async (tx) => {
      await tx.delete('doomed')
    }, {scope: ChangeScope.BlockDefault})
    expect(await isBlockDeleted(env.repo, 'doomed')).toBe(true)

    expect(await env.repo.undo()).toBe(true)
    expect(await isBlockDeleted(env.repo, 'doomed')).toBe(false)
    expect(await readContent(env.repo, 'doomed')).toBe('live')

    expect(await env.repo.redo()).toBe(true)
    expect(await isBlockDeleted(env.repo, 'doomed')).toBe(true)
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

describe('cross-workspace undo isolation (#186)', () => {
  it('does not revert / upload a block in a workspace other than the active one', async () => {
    // Edit a block in workspace A (= WS, the active workspace).
    await seedRoot(env.repo, 'a', 'live')
    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})
    expect(await readContent(env.repo, 'a')).toBe('edited')

    // Switch to a different workspace in-place (no reload, no stack clear).
    env.repo.setActiveWorkspaceId('ws-B')

    // cmd-Z while viewing ws-B must NOT touch the ws-A edit: nothing to
    // undo here, so it no-ops rather than reverting an unopened workspace.
    expect(await env.repo.undo()).toBe(false)
    expect(await readContent(env.repo, 'a')).toBe('edited')

    // The ws-A history survives the switch — back in ws-A, undo works.
    env.repo.setActiveWorkspaceId(WS)
    expect(await env.repo.undo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('live')
  })

  it('does not block an editable-workspace entry while viewing a read-only workspace (A5b)', async () => {
    // Edit a block in editable workspace A (= WS, active).
    await seedRoot(env.repo, 'a', 'live')
    await env.repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    // View a read-only (viewer-role) workspace B.
    env.repo.setActiveWorkspaceId('ws-B')
    env.repo.setReadOnly(true)

    // Pre-fix, this cmd-Z popped the ws-A entry and replayed it under the
    // active (ws-B) read-only flag → spurious ReadOnlyError. Now undo is
    // scoped to ws-B, so the editable ws-A entry is neither reverted nor
    // blocked: undo no-ops without throwing.
    await expect(env.repo.undo()).resolves.toBe(false)
    expect(await readContent(env.repo, 'a')).toBe('edited')

    // Returning to editable A, the entry is still undoable.
    env.repo.setActiveWorkspaceId(WS)
    env.repo.setReadOnly(false)
    expect(await env.repo.undo()).toBe(true)
    expect(await readContent(env.repo, 'a')).toBe('live')
  })
})

describe('local and preference writes are not undoable', () => {
  it('never push onto the undo stack', async () => {
    await seedRoot(env.repo, 'a')

    await env.repo.tx(async (tx) => {
      await tx.update('a', {properties: {focused: 'true'}})
    }, {scope: ChangeScope.UiState})
    await env.repo.tx(async (tx) => {
      await tx.update('a', {properties: {recentBlockIds: ['a']}})
    }, {scope: ChangeScope.UserPrefs})

    expect(env.repo.undoManager.depths(ChangeScope.BlockDefault)).toEqual({undo: 0, redo: 0})
    expect(env.repo.undoManager.depths(ChangeScope.UiState)).toEqual({undo: 0, redo: 0})
    expect(env.repo.undoManager.depths(ChangeScope.UserPrefs)).toEqual({undo: 0, redo: 0})
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

describe('replay ordering vs parent-liveness trigger', () => {
  // core.merge touches the rehomed children before tombstoning the
  // merged-from block, so a first-touch-order replay would restore the
  // children under a still-tombstoned parent and abort on the
  // blocks_parent_not_deleted trigger. `replayApplicationOrder` must
  // make the whole round-trip work regardless of touch order.
  // Found by repoMutators.fuzz.test.ts.
  it('undoes and redoes a merge of a block that has children', async () => {
    await seedRoot(env.repo, 'root')
    const a = await env.repo.mutate.createChild({parentId: 'root', content: 'A'})
    const b = await env.repo.mutate.createChild({parentId: a, content: 'B'})
    env.repo.undoManager.clear()

    await env.repo.mutate.merge({intoId: 'root', fromId: a})
    expect(await isBlockDeleted(env.repo, a)).toBe(true)

    expect(await env.repo.undo()).toBe(true)
    expect(await isBlockDeleted(env.repo, a)).toBe(false)
    const bRow = await env.repo.db.get<{parent_id: string}>(
      'SELECT parent_id FROM blocks WHERE id = ?', [b])
    expect(bRow.parent_id).toBe(a)

    expect(await env.repo.redo()).toBe(true)
    expect(await isBlockDeleted(env.repo, a)).toBe(true)
    const bRow2 = await env.repo.db.get<{parent_id: string}>(
      'SELECT parent_id FROM blocks WHERE id = ?', [b])
    expect(bRow2.parent_id).toBe('root')
  })
})

describe('replay ordering vs alias-uniqueness trigger', () => {
  // Merging two alias-carrying blocks hands the source's alias to the
  // target (mergeProperties array union). Undo must restore the source
  // (re-claiming its alias) AND revert the target (releasing it) in the
  // same replay tx — a fixed application order can deadlock on the
  // block_aliases_workspace_alias_unique trigger when the source is
  // applied while the target still owns the merged alias. The replay
  // worklist retries constraint-aborted rows after the releasing row
  // lands.
  it('undoes and redoes a merge where both blocks own aliases', async () => {
    await seedRoot(env.repo, 'root')
    const a = await env.repo.mutate.createChild({parentId: 'root', content: 'A'})
    const b = await env.repo.mutate.createChild({parentId: 'root', content: 'B'})
    await env.repo.mutate.setProperty({id: a, schema: aliasesProp, value: ['alias-a']})
    await env.repo.mutate.setProperty({id: b, schema: aliasesProp, value: ['alias-b']})
    env.repo.undoManager.clear()

    await env.repo.mutate.merge({intoId: a, fromId: b})
    expect(await isBlockDeleted(env.repo, b)).toBe(true)

    expect(await env.repo.undo()).toBe(true)
    expect(await isBlockDeleted(env.repo, b)).toBe(false)
    const claim = await env.repo.db.getAll<{block_id: string}>(
      'SELECT block_id FROM block_aliases WHERE alias = ? ORDER BY block_id', ['alias-b'])
    expect(claim).toEqual([{block_id: b}])

    expect(await env.repo.redo()).toBe(true)
    expect(await isBlockDeleted(env.repo, b)).toBe(true)
    const claimAfterRedo = await env.repo.db.getAll<{block_id: string}>(
      'SELECT block_id FROM block_aliases WHERE alias = ? ORDER BY block_id', ['alias-b'])
    expect(claimAfterRedo).toEqual([{block_id: a}])
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

/** A one-way pass (the props-as-blocks flip, a `WorkspaceBackfill`) drops the
 *  workspace's history so its own writes cannot be reverted onto. These pin the
 *  three orderings that a bare `clear()` after the pass's commit gets wrong —
 *  each is driven with a raw `clear()` / `beginHistoryDrop()` standing in for
 *  the pass, because what is under test is the Repo's side of the contract, not
 *  any one pass.
 *
 *  All of this protects the tab that cleared, and only that tab. Another tab's
 *  `UndoManager` is a different object holding its own stale entries; that is
 *  issue #1007 and is not addressed here. */
describe('undo against a pass that drops the history', () => {
  const undoDepth = (repo: Repo): number =>
    repo.undoManager.depths(ChangeScope.BlockDefault).undo

  /** Park a transaction on the write lock, so whatever the test starts next
   *  queues behind it. Resolves once the lock is actually HELD — several tests
   *  here turn on a replay being granted the lock only after something else
   *  releases it, which a test that merely started a transaction cannot promise. */
  const holdWriteLock = async (repo: Repo): Promise<{
    settled: Promise<void>
    release: () => void
  }> => {
    let release: (() => void) | null = null
    const settled = repo.tx(
      async () => { await new Promise<void>(resolve => { release = () => resolve() }) },
      {scope: ChangeScope.BlockDefault},
    )
    await vi.waitFor(() => { expect(release).not.toBeNull() }, {timeout: 3000})
    return {settled, release: (): void => { release!() }}
  }

  it('finds nothing to replay when the history is cleared while the gesture waits for the lock', async () => {
    // The gesture takes its entry only once it holds the write lock, so a clear
    // landing while it queues empties the very stack it would have taken from.
    // Taken at press time instead, the entry would be out of the clear's reach,
    // and the replay would land after the pass's commit and restore the
    // pre-pass state of a row the pass has already recorded as done.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    // The write lock is HELD while the replay queues behind it, which is the
    // ordering that matters: clearing before `undo()` is even called is caught
    // by the press-time check, and this is about the one under the lock.
    const lock = await holdWriteLock(repo)

    // Past the press-time check by the next line: the stack was not empty.
    const undoing = repo.undo(ChangeScope.BlockDefault)
    repo.undoManager.clear()
    lock.release()
    await lock.settled

    // False, not a throw: from the user's side the gesture had nothing valid
    // to act on.
    await expect(undoing).resolves.toBe(false)
    // The row is untouched — the replay refused rather than writing back a
    // snapshot the cleared history said was no longer safe to restore.
    expect(await readContent(repo, 'a')).toBe('edited')
  })

  it('refuses a replay a pass invalidated without dropping the stacks', async () => {
    // BEGINNING a drop is what a pass does while it still holds the write lock,
    // before it knows whether its chunk will commit. The stacks survive until
    // the drop is finished, so this pins that the replay, once it holds the
    // lock, asks whether a drop is under way rather than whether the stack is
    // empty.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    const lock = await holdWriteLock(repo)

    const undoing = repo.undo(ChangeScope.BlockDefault)
    repo.undoManager.beginHistoryDrop()
    lock.release()
    await lock.settled

    await expect(undoing).resolves.toBe(false)
    expect(await readContent(repo, 'a')).toBe('edited')
  })

  it('neither commits nor puts back a replay whose history is cleared mid-apply', async () => {
    // A bare `clear()` holds no lock, so it can land while a replay is applying
    // — after that replay took its entry off the stack, where the clear cannot
    // reach it. The replay must roll back rather than commit a pre-clear
    // snapshot, and must NOT push its entry back on the way out: that would
    // REPOPULATE the history the clear just emptied, and the next cmd-Z would
    // replay it. Unlike a pass's drop, nothing empties the stacks afterwards.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    const applyRaw = TxImpl.prototype.applyRaw
    const spy = vi.spyOn(TxImpl.prototype, 'applyRaw').mockImplementation(
      async function (this: TxImpl, ...args: Parameters<typeof applyRaw>) {
        const result = await applyRaw.apply(this, args)
        repo.undoManager.clear()
        return result
      })

    await expect(repo.undo(ChangeScope.BlockDefault)).resolves.toBe(false)
    spy.mockRestore()
    expect(await readContent(repo, 'a')).toBe('edited')
    expect(repo.undoManager.depths(ChangeScope.BlockDefault)).toEqual({undo: 0, redo: 0})
  })

  it('keeps the entry of an edit that took the lock mid-drop, for an IN-LOCK pass', async () => {
    // The pass committed under the write lock it held, so its writes are
    // visible the moment that lock is released. An edit that takes the lock
    // next therefore reads POST-pass rows and is perfectly safe to undo — so
    // the finish must not move the epoch again, or the edit is dropped for
    // having sampled in the middle of one event.
    //
    // With no epoch at all, the clear empties the stack and the entry then
    // records onto the empty one, which is what the user expects; a second
    // advance here would be a regression against that.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')

    // The pass's writes are committed and visible; its drop is under way.
    const drop = repo.undoManager.beginHistoryDropInWriteLock()

    // The edit takes the lock now, so its `before` rows are post-pass. The
    // pass's finish lands while it holds the lock.
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited after the pass'})
      drop.finish()
    }, {scope: ChangeScope.BlockDefault, description: 'post-pass edit'})

    expect(undoDepth(repo)).toBe(1)
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('original')
  })

  it('drops the entry of an edit that overlapped a pass whose writes land LATER', async () => {
    // The mirror of the test above, and the reason the two are separate calls.
    // The props-as-blocks flip holds no write lock: it is a server round trip
    // and a raw `db.execute`, so its writes land AFTER the drop begins. An edit
    // that takes the lock in between reads PRE-pass rows — exactly the snapshot
    // a replay must never restore over the landed flip — so this finish has to
    // move the epoch as well.
    const {repo} = env
    await seedRoot(repo, 'a', 'pre-flip')

    // No lock held: the pass's writes are still in flight.
    const drop = repo.undoManager.beginHistoryDrop()

    // The edit takes the lock while they are, so its `before` rows predate
    // them. The pass lands and finishes the drop.
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited while the pass was in flight'})
      drop.finish()
    }, {scope: ChangeScope.BlockDefault, description: 'overlapping edit'})

    expect(undoDepth(repo)).toBe(0)
    expect(await repo.undo()).toBe(false)
    expect(await readContent(repo, 'a')).toBe('edited while the pass was in flight')
  })

  it('rolls the replay back when a lockless pass drops the history mid-apply', async () => {
    // The entry check cannot cover the apply loop, which awaits once per row. A
    // pass that begins its drop WITHOUT the write lock — the flip is a server
    // round trip — moves the epoch while the replay is mid-flight, after that
    // check has passed. Its `finish` can then only suppress the opposite-stack
    // push; it cannot take back rows the replay has already written. Only
    // throwing before the commit does.
    //
    // The bump is injected INSIDE the loop, at the one point a lockless pass
    // could reach: the harness cannot schedule into the middle of a held write
    // lock any other way, and what is asserted afterwards is the row.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    const applyRaw = TxImpl.prototype.applyRaw
    const spy = vi.spyOn(TxImpl.prototype, 'applyRaw').mockImplementation(
      async function (this: TxImpl, ...args: Parameters<typeof applyRaw>) {
        const result = await applyRaw.apply(this, args)
        repo.undoManager.beginHistoryDrop()
        return result
      })

    // False, not a throw, and — the point — the row is untouched: the replay
    // wrote 'original' and then rolled it back rather than committing it.
    await expect(repo.undo(ChangeScope.BlockDefault)).resolves.toBe(false)
    spy.mockRestore()
    expect(await readContent(repo, 'a')).toBe('edited')
  })

  it('refuses a cmd-Z STARTED while a lockless pass is still landing', async () => {
    // The window the epoch cannot cover. A drop marks an instant, so a gesture
    // that starts after it samples the already-moved value and passes every
    // check — then restores rows from before writes that are landing as it
    // runs. For the flip that window is a server round trip wide, and what it
    // would commit is a pre-flip snapshot over a PATCH the server has taken.
    const {repo} = env
    await seedRoot(repo, 'a', 'pre-flip')
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'user edit, still pre-flip'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    // The pass has begun its drop and is awaiting the server.
    const drop = repo.undoManager.beginHistoryDrop()

    expect(await repo.undo(ChangeScope.BlockDefault)).toBe(false)
    expect(await readContent(repo, 'a')).toBe('user edit, still pre-flip')

    // And once it has landed, the entry is gone rather than merely deferred.
    drop.finish()
    expect(undoDepth(repo)).toBe(0)
  })

  it('takes undo back when a pass ABANDONS its drop, having written nothing', async () => {
    // A pass that can prove it did not write owes the user nothing — but the
    // drop still has to END, or it refuses every replay until reload. That is
    // the failure mode that made a plain suspension the wrong shape here.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    const drop = repo.undoManager.beginHistoryDrop()
    expect(await repo.undo(ChangeScope.BlockDefault)).toBe(false)

    drop.abandon()

    // The history survived, and works.
    expect(undoDepth(repo)).toBe(1)
    expect(await repo.undo(ChangeScope.BlockDefault)).toBe(true)
    expect(await readContent(repo, 'a')).toBe('original')
  })

  it('keeps refusing until the LAST of two overlapping drops ends', async () => {
    // Counted rather than a flag, so the first pass to finish cannot hand
    // replays back while the second is still writing.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    const first = repo.undoManager.beginHistoryDrop()
    const second = repo.undoManager.beginHistoryDrop()
    first.abandon()

    expect(await repo.undo(ChangeScope.BlockDefault)).toBe(false)

    second.abandon()
    expect(await repo.undo(ChangeScope.BlockDefault)).toBe(true)
  })

  it('drops an entry whose transaction held the lock while the history was cleared', async () => {
    // A lockless pass can drop the history while a user transaction holds the
    // write lock. Its `before` rows were read before the pass's writes land, and
    // the clear has already run, so it cannot reach an entry that does not exist
    // yet: without the epoch check the entry lands on the stack holding the
    // whole PRE-pass row, and undoing it reverts the pass with its completion
    // already recorded.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')
    expect(undoDepth(repo)).toBe(0)

    // Stands in for the pass clearing while this transaction holds the lock.
    await repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited while a pass was running'})
      repo.undoManager.clear()
    }, {scope: ChangeScope.BlockDefault, description: 'edit a'})

    // The write stands — only the history entry goes.
    expect(await readContent(repo, 'a')).toBe('edited while a pass was running')
    expect(undoDepth(repo)).toBe(0)
  })

  it('keeps the entry of an edit that was merely INVOKED while a pass held the lock', async () => {
    // The reverse ordering of the test above, and the one a call-time sample
    // gets wrong: this edit does not commit ahead of the pass, it only STARTS
    // while the pass holds the lock, so it executes after that chunk commits
    // and its `before` rows are the rewritten ones. Undoing it is safe, and
    // discarding the entry would silently cost the user their own edit.
    const {repo} = env
    await seedRoot(repo, 'a', 'original')

    // The pass's WHOLE shape, drop and finish alike, because the finish is what
    // decides this: it empties the stacks without moving the epoch again, so an
    // edit that sampled between the two keeps its entry. Written with only the
    // begin, this pinned a sequence production never runs.
    let releaseHolder: (() => void) | null = null
    let drop: HistoryDrop | undefined
    const holding = repo.tx(async () => {
      await new Promise<void>(resolve => { releaseHolder = () => resolve() })
      drop = repo.undoManager.beginHistoryDropInWriteLock()
    }, {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => { expect(releaseHolder).not.toBeNull() }, {timeout: 3000})

    // Invoked here, so a call-time sample reads the PRE-drop epoch; it acquires
    // the lock, and samples, only after the holder has begun the drop.
    const edit = repo.tx(async (tx) => {
      await tx.update('a', {content: 'edited after the pass'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})
    releaseHolder!()
    await holding
    drop!.finish()
    await edit

    expect(await readContent(repo, 'a')).toBe('edited after the pass')
    expect(undoDepth(repo)).toBe(1)
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('original')
  })
})

/** An ordinary transaction committing while a gesture is in flight (#227).
 *
 *  The stacks have to describe the database in COMMIT order: an entry is safe
 *  to replay only while every row it touches still holds the state on its far
 *  side. These pin the orderings a gesture can lose to — a commit queued AHEAD
 *  of the replay, a commit landing between the replay's commit and the
 *  gesture's push, and a commit landing while a FAILED replay unwinds — through
 *  the public API and the database's own lock, never a sleep. */
describe('undo/redo against a transaction committing mid-gesture (#227)', () => {
  const depths = (repo: Repo) => repo.undoManager.depths(ChangeScope.BlockDefault)

  const edit = (repo: Repo, id: string, content: string) =>
    repo.tx(async (tx) => { await tx.update(id, {content}) },
      {scope: ChangeScope.BlockDefault, description: `set ${id}=${content}`})

  /** Start an edit that is holding the write lock and has not written yet; it
   *  writes once released. Anything started meanwhile queues behind it, so it
   *  commits ahead of them by construction. */
  const editHoldingLock = async (repo: Repo, id: string, content: string) => {
    let release: (() => void) | null = null
    const settled = repo.tx(async (tx) => {
      await new Promise<void>(resolve => { release = resolve })
      await tx.update(id, {content})
    }, {scope: ChangeScope.BlockDefault, description: `set ${id}=${content}`})
    await vi.waitFor(() => { expect(release).not.toBeNull() }, {timeout: 3000})
    return {settled, release: (): void => { release!() }}
  }

  /** Run `between` once the NEXT write transaction has settled — committed or
   *  rolled back, lock released — and before its caller's continuation runs.
   *  That is the gap a gesture's own stack motion used to sit in. Patched on the
   *  raw database, which the Repo's metrics proxy calls through on every
   *  transaction, and removed after one use. */
  const onNextWriteSettled = (between: () => Promise<void>): {fired: () => boolean} => {
    const db = sharedDb.db as unknown as {writeTransaction: (...args: unknown[]) => Promise<unknown>}
    const real = db.writeTransaction.bind(db)
    let fired = false
    db.writeTransaction = async (...args: unknown[]) => {
      delete (db as Record<string, unknown>).writeTransaction
      try {
        return await real(...args)
      } finally {
        fired = true
        await between()
      }
    }
    return {fired: () => fired}
  }

  beforeEach(async () => {
    await seedRoot(env.repo, 'a', 'v0')
  })

  it('does not resurrect redo when a commit lands between the undo replay and its push', async () => {
    const {repo} = env
    await edit(repo, 'a', 'v1')
    await repo.awaitProcessors()

    const hook = onNextWriteSettled(() => edit(repo, 'a', 'v2').then(() => {}))
    expect(await repo.undo()).toBe(true)
    expect(hook.fired()).toBe(true)

    // Undo ran, then v2 committed on top of it: v2 is a new action, so the redo
    // branch it superseded is gone and the undo stack ends in v2.
    expect(await readContent(repo, 'a')).toBe('v2')
    expect(depths(repo)).toEqual({undo: 1, redo: 0})
    expect(await repo.redo()).toBe(false)
    expect(await readContent(repo, 'a')).toBe('v2')
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v0')
  })

  it('keeps commit order on the undo stack when a commit lands between a redo replay and its push', async () => {
    const {repo} = env
    await edit(repo, 'a', 'v1')
    expect(await repo.undo()).toBe(true)
    await repo.awaitProcessors()

    const hook = onNextWriteSettled(() => edit(repo, 'a', 'v2').then(() => {}))
    expect(await repo.redo()).toBe(true)
    expect(hook.fired()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v2')

    // Redo of v1 committed BEFORE v2, so v2 is undone first.
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v1')
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v0')
    expect(depths(repo).undo).toBe(0)
  })

  it('undoes an edit that committed but has not yet resumed its caller', async () => {
    // The lock is released at COMMIT and the edit's caller resumes some time
    // after; a gesture can take the lock in between. Its entry must already be
    // on the stack by then, or the undo reverts the entry UNDER it and writes
    // that one's stale `before` over the edit.
    const {repo} = env
    await edit(repo, 'a', 'v1')
    await repo.awaitProcessors()

    let undone: boolean | null = null
    const hook = onNextWriteSettled(async () => { undone = await repo.undo() })
    await edit(repo, 'a', 'v2')
    expect(hook.fired()).toBe(true)

    expect(undone).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v1')
    expect(depths(repo)).toEqual({undo: 1, redo: 1})
  })

  it('undoes the commit that was queued ahead of the undo, not the entry under it', async () => {
    const {repo} = env
    await edit(repo, 'a', 'v1')

    const ahead = await editHoldingLock(repo, 'a', 'v2')
    const undoing = repo.undo()
    ahead.release()
    await ahead.settled

    // v2 committed first, so it is the newest action: the undo reverts it and
    // leaves v1 alone — never writing v1's `before` over v2.
    expect(await undoing).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v1')
    expect(depths(repo)).toEqual({undo: 1, redo: 1})
    expect(await repo.redo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v2')
  })

  it('refuses a redo whose branch a commit queued ahead of it superseded', async () => {
    const {repo} = env
    await edit(repo, 'a', 'v1')
    expect(await repo.undo()).toBe(true)

    const ahead = await editHoldingLock(repo, 'a', 'v2')
    const redoing = repo.redo()
    ahead.release()
    await ahead.settled

    // v2 is a new action after the undo, which ends the redo branch; replaying
    // v1's `after` over it would revert the user's newest edit.
    expect(await redoing).toBe(false)
    expect(await readContent(repo, 'a')).toBe('v2')
    expect(depths(repo)).toEqual({undo: 1, redo: 0})
  })

  it('puts a failed replay back BELOW a commit that landed while it unwound', async () => {
    const {repo} = env
    await edit(repo, 'a', 'v1')
    await repo.awaitProcessors()

    const failure = new Error('replay failed')
    const spy = vi.spyOn(TxImpl.prototype, 'applyRaw').mockRejectedValueOnce(failure)
    const hook = onNextWriteSettled(() => edit(repo, 'a', 'v2').then(() => {}))
    await expect(repo.undo()).rejects.toBe(failure)
    spy.mockRestore()
    expect(hook.fired()).toBe(true)

    // The failed undo changed nothing, so history reads v1 then v2 — the retry
    // reverts v2 first, exactly as if the failed press had never happened.
    expect(await readContent(repo, 'a')).toBe('v2')
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v1')
    expect(await repo.undo()).toBe(true)
    expect(await readContent(repo, 'a')).toBe('v0')
  })
})
