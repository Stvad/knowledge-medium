// @vitest-environment node
/**
 * Tx engine tests (spec §5.3 / §10 / §4.7).
 *
 * Every test runs against a real `@powersync/node` PowerSyncDatabase via
 * the `createTestDb` harness — same `db.execute` / `db.writeTransaction`
 * surface as production, real SQLite, real triggers. So:
 *   - command_events + upload routing fire when primitives write, gated by
 *     the `(tx_id, source)` set in `tx_context`
 *   - the upload-routing trigger fires on `source = 'user'` writes
 *   - the workspace-invariant trigger fires on local writes (and would
 *     ABORT a cross-workspace child)
 *
 * The Tx engine is exercised through the public `Repo.tx(fn, opts)` —
 * not in isolation. That's the full pipeline: open writeTransaction,
 * set tx_context, run fn, write command_events, clear tx_context, walk
 * snapshots → cache.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  CycleError,
  DeletedConflictError,
  DeterministicIdCrossWorkspaceError,
  DuplicateIdError,
  MutatorNotRegisteredError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  ParentWorkspaceMismatchError,
  ProcessorNotRegisteredError,
  ReadOnlyError,
  WorkspaceMismatchError,
  WorkspaceNotPinnedError,
  codecs,
  defineMutator,
  defineProperty,
  definePostCommitProcessor,
  type Mutator,
  type Schema,
} from '@/data/api'
import { aliasesProp } from '@/data/properties'
import type { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '../repo'

// ──── Test fixtures ────

const stringSchema = <T>(): Schema<T> => ({parse: (x: unknown) => x as T})

const titleProp = defineProperty<string>('title', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

const dateProp = defineProperty<Date | undefined>('due-date', {
  // codecs.date is natively absence-aware (Codec<Date | undefined>).
  codec: codecs.date,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

/** Explicit-watching test processor used by the afterCommit tests. The
 *  apply fn is a no-op — engine tests pin scheduling/rollback semantics,
 *  not what the processor does. Registered via `__setProcessorsForTesting`
 *  in `setup()` so `tx.afterCommit('test.afterCommitProbe', ...)` passes
 *  the §5.7 enqueue-time validation. */
const afterCommitProbeProcessor = definePostCommitProcessor<{fromBlockId: string}>({
  name: 'test.afterCommitProbe',
  watches: { kind: 'explicit' },
  scheduledArgsSchema: stringSchema<{fromBlockId: string}>(),
  apply: async () => {},
})

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
  /** Deterministic clock — increments by 1 ms per `now()` call so tests
   *  can predict ordering without relying on wall-clock timing. */
  tick: () => number
  /** Counter snapshot helpers. */
  commandEvents(): Promise<Array<{tx_id: string; scope: string; workspace_id: string | null; source: string}>>
  psCrud(): Promise<Array<{data: string}>>
}

const setup = async (overrides?: {isReadOnly?: boolean}): Promise<Harness> => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  let timeCursor = 1700_000_000_000
  const tick = () => ++timeCursor
  // Engine tests pin Tx primitive behavior. Kernel processors firing
  // on content writes would add follow-up txs (parseReferences) the
  // engine assertions don't account for — keep the processor surface
  // empty and let the parseReferences integration tests cover it.
  const {repo, cache} = createTestRepo({
    db: h.db,
    user: {id: 'user-1', name: 'Test'},
    isReadOnly: overrides?.isReadOnly,
    now: tick,
  })
  // Register only the local test probe — afterCommit tests use it to
  // schedule explicit jobs. The rest of the engine tests don't call
  // afterCommit so the registry stays effectively empty for them.
  repo.__setProcessorsForTesting([afterCommitProbeProcessor])
  return {
    h,
    cache,
    repo,
    tick,
    commandEvents: () =>
      h.db.getAll('SELECT tx_id, scope, workspace_id, source FROM command_events ORDER BY created_at'),
    psCrud: () => h.db.getAll('SELECT data FROM ps_crud ORDER BY id'),
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

// ──── tx.create ────

describe('tx.create', () => {
  it('inserts a row, captures snapshot, updates cache on commit, fires upload trigger', async () => {
    const id = await env.repo.tx(async tx => {
      return await tx.create({
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: 'hello',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create-leaf'})
    expect(id).toMatch(/^gen-/)

    // Cache populated post-commit walk.
    const snap = env.cache.getSnapshot(id)!
    expect(snap.id).toBe(id)
    expect(snap.workspaceId).toBe('ws-1')
    expect(snap.content).toBe('hello')
    expect(snap.deleted).toBe(false)
    expect(snap.createdAt).toBeGreaterThan(0)
    expect(snap.createdBy).toBe('user-1')

    // command_events records the user tx.
    const cmds = await env.commandEvents()
    expect(cmds.length).toBe(1)
    expect(cmds[0]).toMatchObject({scope: 'block-default', workspace_id: 'ws-1', source: 'user'})

    // Upload routing: ps_crud has the PUT envelope.
    const crud = await env.psCrud()
    expect(crud.length).toBe(1)
    expect(JSON.parse(crud[0].data)).toMatchObject({op: 'PUT', type: 'blocks', id})
  })

  it('uses the engine-generated id when caller omits id', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(id).toMatch(/^gen-/)
  })

  it('respects an explicit id (deterministic-helper path)', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'explicit-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(env.cache.getSnapshot('explicit-1')).toBeDefined()
  })

  it('throws DuplicateIdError on PK conflict', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'dup', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await expect(env.repo.tx(
      tx => tx.create({id: 'dup', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(DuplicateIdError)
  })

  it('throws ParentNotFoundError when parent_id is missing', async () => {
    await expect(env.repo.tx(
      tx => tx.create({id: 'dangling-child', workspaceId: 'ws-1', parentId: 'missing-parent', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(ParentNotFoundError)
    expect(env.cache.getSnapshot('dangling-child')).toBeUndefined()
  })

  it('throws ParentWorkspaceMismatchError when parent is in another workspace', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'other-ws-parent', workspaceId: 'ws-A', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await expect(env.repo.tx(
      tx => tx.create({id: 'cross-ws-child', workspaceId: 'ws-B', parentId: 'other-ws-parent', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(ParentWorkspaceMismatchError)
    expect(env.cache.getSnapshot('cross-ws-child')).toBeUndefined()
  })
})

// ──── tx.createOrGet ────

describe('tx.createOrGet', () => {
  it('inserts on missing — inserted: true', async () => {
    const result = await env.repo.tx(
      tx => tx.createOrGet({id: 'det-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(result).toEqual({id: 'det-1', inserted: true})
  })

  it('returns existing live row — inserted: false', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'det-2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'pre-existing'}),
      {scope: ChangeScope.BlockDefault},
    )
    const result = await env.repo.tx(
      tx => tx.createOrGet({id: 'det-2', workspaceId: 'ws-1', parentId: null, orderKey: 'a1', content: 'ignored'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(result).toEqual({id: 'det-2', inserted: false})
    // Live-row hit: no overwrite, original content preserved.
    expect(env.cache.getSnapshot('det-2')!.content).toBe('pre-existing')
  })

  it('throws DeletedConflictError on tombstone (domain helper does the restore)', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'det-3', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete('det-3'), {scope: ChangeScope.BlockDefault})
    await expect(env.repo.tx(
      tx => tx.createOrGet({id: 'det-3', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(DeletedConflictError)
  })

  it('throws DeterministicIdCrossWorkspaceError on workspace mismatch', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'det-4', workspaceId: 'ws-A', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await expect(env.repo.tx(
      tx => tx.createOrGet({id: 'det-4', workspaceId: 'ws-B', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(DeterministicIdCrossWorkspaceError)
  })

  it('throws ParentNotFoundError on insert path when parent_id is missing', async () => {
    await expect(env.repo.tx(
      tx => tx.createOrGet({id: 'det-missing-parent', workspaceId: 'ws-1', parentId: 'missing-parent', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(ParentNotFoundError)
    expect(env.cache.getSnapshot('det-missing-parent')).toBeUndefined()
  })

  it('does NOT pin workspace on a live-row hit, so tx.afterCommit still throws WorkspaceNotPinnedError', async () => {
    // Pre-seed a row.
    await env.repo.tx(
      tx => tx.create({id: 'det-livehit', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    // A tx whose only effect is a createOrGet live-hit must NOT pin
    // workspace — afterCommit should refuse because no row_events /
    // command_events row claims this workspace.
    await expect(env.repo.tx(async tx => {
      const r = await tx.createOrGet({id: 'det-livehit', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      expect(r).toEqual({id: 'det-livehit', inserted: false})
      expect(tx.meta.workspaceId).toBeNull()
      tx.afterCommit('test.afterCommitProbe', {fromBlockId: 'det-livehit'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(WorkspaceNotPinnedError)
  })

  it('a tx that adds a real write after a live-hit pins from the write, not from the live-hit', async () => {
    // Pre-seed a row in ws-1.
    await env.repo.tx(
      tx => tx.create({id: 'det-mixed', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    // The createOrGet live-hits ws-1's row; the create then writes to
    // ws-2. Because live-hit doesn't pin, the write-side pin to ws-2
    // wins — no WorkspaceMismatchError is raised. (This is the explicit
    // tradeoff for the no-live-hit-pin rule; in practice
    // deterministic-id callers thread the same workspaceId throughout.)
    await env.repo.tx(async tx => {
      await tx.createOrGet({id: 'det-mixed', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'det-mixed-2', workspaceId: 'ws-2', parentId: null, orderKey: 'a0'})
      expect(tx.meta.workspaceId).toBe('ws-2')
    }, {scope: ChangeScope.BlockDefault})
  })
})

// ──── tx.update ────

describe('tx.update (data-fields-only)', () => {
  it('writes through to SQL; cache reflects post-commit', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'before'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.update(id, {content: 'after'}), {scope: ChangeScope.BlockDefault})
    expect(env.cache.getSnapshot(id)!.content).toBe('after')
  })

  it('skips SQL and upload routing when the patch is a semantic no-op', async () => {
    await env.repo.tx(
      tx => tx.create({
        id: 'upd-noop',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: 'same',
        references: [{id: 'ref-a', alias: 'A'}, {id: 'ref-b', alias: 'B'}],
        properties: {title: 'Inbox'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    const beforeCrud = await env.psCrud()
    const beforeUpdatedAt = env.cache.getSnapshot('upd-noop')!.updatedAt

    await env.repo.tx(
      tx => tx.update('upd-noop', {
        content: 'same',
        references: [{id: 'ref-b', alias: 'B'}, {id: 'ref-a', alias: 'A'}],
        properties: {title: 'Inbox'},
      }),
      {scope: ChangeScope.BlockDefault},
    )

    // No new upload envelope and no metadata bump ⇒ the write was skipped.
    expect(await env.psCrud()).toHaveLength(beforeCrud.length)
    expect(env.cache.getSnapshot('upd-noop')!.updatedAt).toBe(beforeUpdatedAt)
  })

  it('always advances updatedAt; userUpdatedAt + updatedBy bump only on a real edit', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const created = env.cache.getSnapshot(id)!
    env.tick()  // advance virtual clock
    await env.repo.tx(tx => tx.update(id, {content: 'x'}), {scope: ChangeScope.BlockDefault})
    const afterEdit = env.cache.getSnapshot(id)!
    // A real edit advances both the row-version and the display stamp.
    expect(afterEdit.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(afterEdit.userUpdatedAt).toBeGreaterThan(created.userUpdatedAt)

    env.tick()
    await env.repo.tx(tx => tx.update(id, {references: [{id: 'ref', alias: 'a'}]}, {skipMetadata: true}), {scope: ChangeScope.References})
    const afterBookkeeping = env.cache.getSnapshot(id)!
    // A {skipMetadata} bookkeeping write STILL advances the row-version (so
    // peers hydrate the change — this is the staleness fix) but leaves the
    // user-facing display stamp frozen.
    expect(afterBookkeeping.updatedAt).toBeGreaterThan(afterEdit.updatedAt)
    expect(afterBookkeeping.userUpdatedAt).toBe(afterEdit.userUpdatedAt)
  })

  it('a {skipMetadata} write uploads a PATCH carrying the bumped updated_at, not user_updated_at', async () => {
    // The headline staleness fix, at the upload boundary. A bookkeeping refs
    // write (alias/backlink reindex) advances the row-version but freezes the
    // display stamp. The column-narrow PATCH must carry the bumped `updated_at`
    // — so a peer's reconcile gate sees a newer version and applies the change
    // (pre-fix it froze updated_at and the peer skip-staled it forever) — and
    // must NOT carry `user_updated_at` (display stays put).
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'x'}),
      {scope: ChangeScope.BlockDefault},
    )
    env.tick()
    await env.repo.tx(
      tx => tx.update(id, {references: [{id: 'ref', alias: 'a'}]}, {skipMetadata: true}),
      {scope: ChangeScope.References},
    )
    const patch = (await env.psCrud())
      .map(r => JSON.parse(r.data) as {op: string; id: string; data: Record<string, unknown>})
      .find(e => e.op === 'PATCH' && e.id === id)
    expect(patch).toBeDefined()
    expect(patch!.data).toHaveProperty('updated_at')          // peers see a newer version
    expect(patch!.data).toHaveProperty('references_json')     // the bookkeeping content
    expect(patch!.data).not.toHaveProperty('user_updated_at') // display frozen
  })

  it('keeps updated_at locally monotonic when the row-version is ahead of the local clock (I3)', async () => {
    // A slow-clock device whose now() trails a server-ratcheted stamp must not
    // regress the row-version: metadataPatch stamps max(now, before.updatedAt+1),
    // not now(). Without the max(), a fresh edit would stamp BELOW the row's
    // current version and the gate would turn the next delivery into a disk
    // revert. (This guard is invisible to tests with a strictly-increasing
    // clock — hence the explicit raw ratchet below.)
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'x'}),
      {scope: ChangeScope.BlockDefault},
    )
    // Simulate the server ratcheting the row-version far ahead of this device's
    // clock. Raw write (no repo.tx) → no upload trigger; the SQLite table has no
    // clamp (that's server-side), so this lands verbatim.
    const ratcheted = env.tick() + 1_000_000
    await env.h.db.execute('UPDATE blocks SET updated_at = ? WHERE id = ?', [ratcheted, id])

    await env.repo.tx(tx => tx.update(id, {content: 'edited'}), {scope: ChangeScope.BlockDefault})

    const snap = env.cache.getSnapshot(id)!
    expect(snap.updatedAt).toBe(ratcheted + 1)                 // floored to before+1, not now()
    expect(snap.userUpdatedAt).toBeLessThan(snap.updatedAt)    // display stamp is plain now()
  })
})

// ──── tx.stampReferenceTarget (local derived column) ────

describe('tx.stampReferenceTarget (local, no-upload)', () => {
  it('writes the column without advancing updated_at or enqueuing an upload', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: '((t))'}),
      {scope: ChangeScope.BlockDefault},
    )
    const createdAt = env.cache.getSnapshot(id)!.updatedAt
    env.tick() // advance the clock: a stray updated_at bump would use this later value
    const crudBefore = (await env.psCrud()).length

    await env.repo.tx(tx => tx.stampReferenceTarget(id, 'target-x'), {scope: ChangeScope.BlockDefault})

    const snap = env.cache.getSnapshot(id)!
    expect(snap.referenceTargetId).toBe('target-x')  // column written
    expect(snap.updatedAt).toBe(createdAt)           // NOT advanced — not a synced edit
    expect((await env.psCrud()).length).toBe(crudBefore)  // no upload envelope minted
  })

  it('is a no-op (no UPDATE, no row_event) when the column already holds the target', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: '((t))'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.stampReferenceTarget(id, 'target-x'), {scope: ChangeScope.BlockDefault})
    const rowEventsAfterFirst = (
      await env.h.db.getAll('SELECT id FROM row_events WHERE block_id = ?', [id])
    ).length

    await env.repo.tx(tx => tx.stampReferenceTarget(id, 'target-x'), {scope: ChangeScope.BlockDefault})

    // The guard short-circuits before any UPDATE, so the no-WHEN row_event
    // trigger never fires — the count is unchanged.
    expect((await env.h.db.getAll('SELECT id FROM row_events WHERE block_id = ?', [id])).length)
      .toBe(rowEventsAfterFirst)
    expect(env.cache.getSnapshot(id)!.referenceTargetId).toBe('target-x')
  })
})

// ──── tx.delete + tx.restore ────

describe('tx.delete + tx.restore', () => {
  it('soft-delete: deleted flips 0→1 and uploads a PATCH setting deleted', async () => {
    const id = await env.repo.tx(
      tx => tx.create({id: 'sd-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.delete(id), {scope: ChangeScope.BlockDefault})
    expect(env.cache.getSnapshot(id)!.deleted).toBe(true)
    // The soft-delete is a PATCH (not a row removal) that sets deleted = 1.
    const ops = (await env.psCrud()).map(r => JSON.parse(r.data) as {op: string; data: Record<string, unknown>})
    expect(ops.map(e => e.op)).toEqual(['PUT', 'PATCH'])
    expect(ops[1].data).toMatchObject({deleted: true})
  })

  it('delete on already-soft-deleted row is a no-op', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'sd-2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.delete('sd-2'), {scope: ChangeScope.BlockDefault})
    const afterFirstDelete = (await env.psCrud()).length
    await env.repo.tx(tx => tx.delete('sd-2'), {scope: ChangeScope.BlockDefault})
    // The second delete writes nothing — no new upload envelope.
    expect((await env.psCrud()).length).toBe(afterFirstDelete)
  })

  it('tx.restore un-soft-deletes; throws NotDeletedError on a live row', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'r-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'x'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.delete('r-1'), {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.restore('r-1', {content: 'y'}), {scope: ChangeScope.BlockDefault})
    expect(env.cache.getSnapshot('r-1')).toMatchObject({deleted: false, content: 'y'})

    // Restoring a live row: NotDeletedError.
    await expect(env.repo.tx(tx => tx.restore('r-1'), {scope: ChangeScope.BlockDefault}))
      .rejects.toThrow(NotDeletedError)
  })
})

// ──── tx.move + cycle validation ────

describe('tx.move (cycle validation, §4.7 Layer 1)', () => {
  beforeEach(async () => {
    // Tree:  root → A → B → C
    await env.repo.tx(async tx => {
      await tx.create({id: 'mv-root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'mv-A',    workspaceId: 'ws-1', parentId: 'mv-root', orderKey: 'a0'})
      await tx.create({id: 'mv-B',    workspaceId: 'ws-1', parentId: 'mv-A',    orderKey: 'a0'})
      await tx.create({id: 'mv-C',    workspaceId: 'ws-1', parentId: 'mv-B',    orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
  })

  it('moves to a valid new parent', async () => {
    await env.repo.tx(
      tx => tx.move('mv-C', {parentId: 'mv-root', orderKey: 'b0'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(env.cache.getSnapshot('mv-C')).toMatchObject({parentId: 'mv-root', orderKey: 'b0'})
  })

  it('skips SQL and upload routing when target parent/order are unchanged', async () => {
    const beforeCrud = await env.psCrud()
    const beforeUpdatedAt = env.cache.getSnapshot('mv-C')!.updatedAt

    await env.repo.tx(
      tx => tx.move('mv-C', {parentId: 'mv-B', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )

    // No new upload envelope and no metadata bump ⇒ the write was skipped.
    expect(await env.psCrud()).toHaveLength(beforeCrud.length)
    expect(env.cache.getSnapshot('mv-C')!.updatedAt).toBe(beforeUpdatedAt)
  })

  it('re-roots to null without cycle check', async () => {
    await env.repo.tx(
      tx => tx.move('mv-C', {parentId: null, orderKey: 'a1'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(env.cache.getSnapshot('mv-C')).toMatchObject({parentId: null})
  })

  it('throws CycleError when target parent is a descendant of the moved id', async () => {
    // moving A under C would make A a descendant of itself (A → C → B → A).
    await expect(env.repo.tx(
      tx => tx.move('mv-A', {parentId: 'mv-C', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(CycleError)
    // Original tree intact (rollback worked).
    expect(env.cache.getSnapshot('mv-A')!.parentId).toBe('mv-root')
  })

  it('throws CycleError on self-cycle', async () => {
    await expect(env.repo.tx(
      tx => tx.move('mv-A', {parentId: 'mv-A', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(CycleError)
  })

  it('detects a cycle several levels deep, not just an immediate child', async () => {
    // Extend root→A→B→C with D under C, then try to move A under D. D is A's
    // descendant four hops down, so the ancestor walk has to traverse
    // D→C→B→A to catch it — exercises multi-hop recursion, not a 2-cycle.
    await env.repo.tx(
      tx => tx.create({id: 'mv-D', workspaceId: 'ws-1', parentId: 'mv-C', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await expect(env.repo.tx(
      tx => tx.move('mv-A', {parentId: 'mv-D', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(CycleError)
    expect(env.cache.getSnapshot('mv-A')!.parentId).toBe('mv-root')
  })

  it('throws CycleError when the cycle runs through a soft-deleted intermediate (issue #183)', async () => {
    // Soft-delete B, the middle of root→A→B→C. Moving A under C still closes a
    // structural cycle A→C→B→A; the ancestor walk must traverse the deleted B
    // edge to see it. Before the fix the `deleted=0` filter stopped the walk at
    // B and the move landed, creating a durable cycle invisible to reads.
    await env.repo.tx(
      tx => tx.delete('mv-B'),
      {scope: ChangeScope.BlockDefault},
    )
    await expect(env.repo.tx(
      tx => tx.move('mv-A', {parentId: 'mv-C', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(CycleError)
    // Rolled back: A still under root, the rest of the chain untouched.
    expect(env.cache.getSnapshot('mv-A')!.parentId).toBe('mv-root')
    expect(env.cache.getSnapshot('mv-C')!.parentId).toBe('mv-B')
  })

  it('throws ParentDeletedError (not CycleError) when the deleted target is also a descendant (issue #183)', async () => {
    // Soft-delete C, then move B under C. C is both a tombstone AND a
    // descendant of B, so the cycle walk (which now crosses deleted edges)
    // would close a loop B→C→B — but the parent-deleted contract must win.
    await env.repo.tx(
      tx => tx.delete('mv-C'),
      {scope: ChangeScope.BlockDefault},
    )
    await expect(env.repo.tx(
      tx => tx.move('mv-B', {parentId: 'mv-C', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(ParentDeletedError)
    expect(env.cache.getSnapshot('mv-B')!.parentId).toBe('mv-A')
  })

  it('allows reparenting a tombstone under a soft-deleted parent (matches the NEW.deleted=0 trigger)', async () => {
    // The parent-deleted preflight must not tighten move beyond the storage
    // invariant: the trigger only rejects live rows (NEW.deleted=0), so a
    // tombstone may be parked under another tombstone. Soft-delete both C and
    // (separately) a root sibling X, then move the tombstoned X under C.
    await env.repo.tx(async tx => {
      await tx.create({id: 'mv-X', workspaceId: 'ws-1', parentId: 'mv-root', orderKey: 'b0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      await tx.delete('mv-C')
      await tx.delete('mv-X')
    }, {scope: ChangeScope.BlockDefault})

    await env.repo.tx(
      tx => tx.move('mv-X', {parentId: 'mv-C', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(env.cache.getSnapshot('mv-X')).toMatchObject({parentId: 'mv-C', deleted: true})
  })

  it('restoring a node never exposes a live cycle (issue #183)', async () => {
    // Same setup: B soft-deleted, the cycle-creating move rejected above. Once
    // the guard holds, restoring B brings back the original acyclic structure
    // rather than a live 3-cycle.
    await env.repo.tx(
      tx => tx.delete('mv-B'),
      {scope: ChangeScope.BlockDefault},
    )
    await expect(env.repo.tx(
      tx => tx.move('mv-A', {parentId: 'mv-C', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(CycleError)

    await env.repo.tx(
      tx => tx.restore('mv-B'),
      {scope: ChangeScope.BlockDefault},
    )
    // Original chain root→A→B→C intact — no edge points back up.
    expect(env.cache.getSnapshot('mv-A')!.parentId).toBe('mv-root')
    expect(env.cache.getSnapshot('mv-B')!.parentId).toBe('mv-A')
    expect(env.cache.getSnapshot('mv-C')!.parentId).toBe('mv-B')
  })

  it('does NOT catch a loop deeper than the §4.7 depth-guard cap (documented truncation)', async () => {
    // The ancestor walk is bounded by `depth < 100` so a pathological chain
    // can't run the recursion away. The trade-off: a loop that closes past the
    // cap is knowingly missed. CHAIN must stay above the cap; if the cap moves,
    // this is the test that flags it.
    const CHAIN = 110
    await env.repo.tx(async tx => {
      await tx.create({id: 'deep-0', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      for (let i = 1; i <= CHAIN; i++) {
        await tx.create({id: `deep-${i}`, workspaceId: 'ws-1', parentId: `deep-${i - 1}`, orderKey: 'a0'})
      }
    }, {scope: ChangeScope.BlockDefault})

    // deep-110 is a descendant of deep-0, so this closes a loop — but it's past
    // the cap, so the guard truncates before reaching deep-0 and the move lands.
    await env.repo.tx(
      tx => tx.move('deep-0', {parentId: `deep-${CHAIN}`, orderKey: 'b0'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(env.cache.getSnapshot('deep-0')).toMatchObject({parentId: `deep-${CHAIN}`})
  })

  it('throws ParentNotFoundError when target parent_id is missing', async () => {
    await expect(env.repo.tx(
      tx => tx.move('mv-A', {parentId: 'missing-parent', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(ParentNotFoundError)
    expect(env.cache.getSnapshot('mv-A')!.parentId).toBe('mv-root')
  })

  it('throws ParentWorkspaceMismatchError when target parent is in another workspace', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'mv-other-ws-parent', workspaceId: 'ws-2', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await expect(env.repo.tx(
      tx => tx.move('mv-A', {parentId: 'mv-other-ws-parent', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(ParentWorkspaceMismatchError)
    expect(env.cache.getSnapshot('mv-A')!.parentId).toBe('mv-root')
  })
})

// ──── tx.setProperty / tx.getProperty (codec boundary) ────

describe('tx.setProperty / tx.getProperty (codec boundary)', () => {
  it('round-trips a primitive-coded value through SQL', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.setProperty(id, titleProp, 'Inbox'), {scope: ChangeScope.BlockDefault})
    const got = await env.repo.tx(tx => tx.getProperty(id, titleProp), {scope: ChangeScope.BlockDefault})
    expect(got).toBe('Inbox')
  })

  it('skips SQL and upload routing when the encoded value is already stored', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'prop-noop', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.setProperty('prop-noop', titleProp, 'Inbox')
    }, {scope: ChangeScope.BlockDefault})
    const beforeCrud = await env.psCrud()
    const beforeUpdatedAt = env.cache.getSnapshot('prop-noop')!.updatedAt

    await env.repo.tx(
      tx => tx.setProperty('prop-noop', titleProp, 'Inbox'),
      {scope: ChangeScope.BlockDefault},
    )

    // No new upload envelope and no metadata bump ⇒ the write was skipped.
    expect(await env.psCrud()).toHaveLength(beforeCrud.length)
    expect(env.cache.getSnapshot('prop-noop')!.updatedAt).toBe(beforeUpdatedAt)
  })

  it('does not pin a workspace for a no-op-only tx', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'pin-noop', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.setProperty('pin-noop', titleProp, 'Inbox')
    }, {scope: ChangeScope.BlockDefault})

    await env.repo.tx(
      tx => tx.setProperty('pin-noop', titleProp, 'Inbox'),
      {scope: ChangeScope.BlockDefault},
    )

    const cmds = await env.commandEvents()
    expect(cmds.at(-1)!.workspace_id).toBeNull()
  })

  it('still throws WorkspaceNotPinnedError when afterCommit follows only a no-op write', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'ac-noop', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.setProperty('ac-noop', titleProp, 'Inbox')
    }, {scope: ChangeScope.BlockDefault})

    await expect(env.repo.tx(async tx => {
      await tx.setProperty('ac-noop', titleProp, 'Inbox')
      tx.afterCommit('test.afterCommitProbe', {fromBlockId: 'ac-noop'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(WorkspaceNotPinnedError)
  })

  it('encodes Date via codec; storage holds the ISO string', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const d = new Date('2026-04-29T12:00:00Z')
    await env.repo.tx(tx => tx.setProperty(id, dateProp, d), {scope: ChangeScope.BlockDefault})
    // Cache holds encoded shape.
    expect(env.cache.getSnapshot(id)!.properties['due-date']).toBe(d.toISOString())
    // Read decodes.
    const got = await env.repo.tx(tx => tx.getProperty(id, dateProp), {scope: ChangeScope.BlockDefault})
    expect(got!.getTime()).toBe(d.getTime())
  })

  it('returns the schema defaultValue when the property is absent', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const got = await env.repo.tx(tx => tx.getProperty(id, titleProp), {scope: ChangeScope.BlockDefault})
    expect(got).toBe('')
  })
})

// ──── Within-tx tree primitives ────

describe('tx.childrenOf / tx.parentOf', () => {
  it('returns children ordered (order_key, id) and parent or null', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'c-p',   workspaceId: 'ws-1', parentId: null,   orderKey: 'a0'})
      await tx.create({id: 'c-c2',  workspaceId: 'ws-1', parentId: 'c-p',  orderKey: 'a1'})
      await tx.create({id: 'c-c1',  workspaceId: 'ws-1', parentId: 'c-p',  orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      const kids = await tx.childrenOf('c-p')
      expect(kids.map(k => k.id)).toEqual(['c-c1', 'c-c2'])
      expect((await tx.parentOf('c-c2'))!.id).toBe('c-p')
      expect(await tx.parentOf('c-p')).toBeNull()
    }, {scope: ChangeScope.BlockDefault})
  })

  it('hasChildren counts tombstoned children only with {includeDeleted}', async () => {
    await env.repo.tx(async tx => {
      // hc-livep has a live child; hc-p has only a tombstoned child;
      // hc-none never had children.
      await tx.create({id: 'hc-livep', workspaceId: 'ws-1', parentId: null,      orderKey: 'a0'})
      await tx.create({id: 'hc-live',  workspaceId: 'ws-1', parentId: 'hc-livep', orderKey: 'a0'})
      await tx.create({id: 'hc-p',     workspaceId: 'ws-1', parentId: null,      orderKey: 'a1'})
      await tx.create({id: 'hc-del',   workspaceId: 'ws-1', parentId: 'hc-p',    orderKey: 'a0'})
      await tx.create({id: 'hc-none',  workspaceId: 'ws-1', parentId: null,      orderKey: 'a2'})
      await tx.delete('hc-del')
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      expect(await tx.hasChildren('hc-livep')).toBe(true)                       // live child
      expect(await tx.hasChildren('hc-p')).toBe(false)                          // only a tombstone
      expect(await tx.hasChildren('hc-p', {includeDeleted: true})).toBe(true)
      expect(await tx.hasChildren('hc-none', {includeDeleted: true})).toBe(false)
    }, {scope: ChangeScope.BlockDefault})
  })

  it('finds adjacent siblings without enumerating the full sibling list', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'adj-p',  workspaceId: 'ws-1', parentId: null,    orderKey: 'a0'})
      await tx.create({id: 'adj-a',  workspaceId: 'ws-1', parentId: 'adj-p', orderKey: 'a0'})
      await tx.create({id: 'adj-b',  workspaceId: 'ws-1', parentId: 'adj-p', orderKey: 'a1'})
      await tx.create({id: 'adj-c',  workspaceId: 'ws-1', parentId: 'adj-p', orderKey: 'a2'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      const b = (await tx.get('adj-b'))!
      expect((await tx.adjacentSibling(b, 'before'))?.id).toBe('adj-a')
      expect((await tx.adjacentSibling(b, 'after'))?.id).toBe('adj-c')
      const c = (await tx.get('adj-c'))!
      expect(await tx.adjacentSibling(c, 'after')).toBeNull()
    }, {scope: ChangeScope.BlockDefault})
  })

  it('scopes root adjacent-sibling lookup to the anchor workspace', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'ws1-a', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ws1-b', workspaceId: 'ws-1', parentId: null, orderKey: 'a2'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      await tx.create({id: 'ws2-between', workspaceId: 'ws-2', parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      const root = (await tx.get('ws1-a'))!
      expect((await tx.adjacentSibling(root, 'after'))?.id).toBe('ws1-b')
    }, {scope: ChangeScope.BlockDefault})
  })
})

describe('tx.isDescendantOf', () => {
  // Pins the boolean wrapper + argument order at the public Tx surface.
  // tx.move's cycle guard and blockMerge's pre-check both route through
  // this, so an inverted-argument regression would break two live
  // guarantees at once; the SQL itself is covered in treeQueries.test.ts.
  beforeEach(async () => {
    // gp → p → c
    await env.repo.tx(async tx => {
      await tx.create({id: 'd-gp', workspaceId: 'ws-1', parentId: null,   orderKey: 'a0'})
      await tx.create({id: 'd-p',  workspaceId: 'ws-1', parentId: 'd-gp', orderKey: 'a0'})
      await tx.create({id: 'd-c',  workspaceId: 'ws-1', parentId: 'd-p',  orderKey: 'a0'})
      await tx.create({id: 'd-x',  workspaceId: 'ws-1', parentId: null,   orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
  })

  it('is true when the second arg is an ancestor of the first (and false the other way)', async () => {
    await env.repo.tx(async tx => {
      expect(await tx.isDescendantOf('d-c', 'd-gp')).toBe(true)
      // Argument order matters: ancestor-of-descendant is not symmetric.
      expect(await tx.isDescendantOf('d-gp', 'd-c')).toBe(false)
    }, {scope: ChangeScope.BlockDefault})
  })

  it('is false for unrelated blocks', async () => {
    await env.repo.tx(async tx => {
      expect(await tx.isDescendantOf('d-c', 'd-x')).toBe(false)
    }, {scope: ChangeScope.BlockDefault})
  })

  it('is true on identity (a node is in its own chain)', async () => {
    await env.repo.tx(async tx => {
      expect(await tx.isDescendantOf('d-c', 'd-c')).toBe(true)
    }, {scope: ChangeScope.BlockDefault})
  })
})

describe('tx.aliasLookup', () => {
  it('finds a block by exact alias inside the user tx (read-your-own-writes)', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'al-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Foo'})
      await tx.setProperty('al-1', aliasesProp, ['Foo'])
      // The block_aliases trigger fires on the property write — even
      // mid-tx, the lookup sees the in-flight claimant.
      const claimant = await tx.aliasLookup('Foo', 'ws-1')
      expect(claimant?.id).toBe('al-1')
    }, {scope: ChangeScope.BlockDefault})
  })

  it('returns null when no live block claims the alias', async () => {
    await env.repo.tx(async tx => {
      expect(await tx.aliasLookup('Nope', 'ws-1')).toBeNull()
    }, {scope: ChangeScope.BlockDefault})
  })

  it('is workspace-scoped — a claimant in one workspace does not match in another', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'al-a', workspaceId: 'ws-A', parentId: null, orderKey: 'a0', content: 'X'})
      await tx.setProperty('al-a', aliasesProp, ['Shared'])
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      expect((await tx.aliasLookup('Shared', 'ws-A'))?.id).toBe('al-a')
      expect(await tx.aliasLookup('Shared', 'ws-B')).toBeNull()
    }, {scope: ChangeScope.BlockDefault})
  })

  it('skips soft-deleted claimants', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'al-d', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'X'})
      await tx.setProperty('al-d', aliasesProp, ['Stale'])
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete('al-d'), {scope: ChangeScope.BlockDefault})

    await env.repo.tx(async tx => {
      expect(await tx.aliasLookup('Stale', 'ws-1')).toBeNull()
    }, {scope: ChangeScope.BlockDefault})
  })

  it('returns null for blank alias or workspaceId (defensive)', async () => {
    await env.repo.tx(async tx => {
      expect(await tx.aliasLookup('', 'ws-1')).toBeNull()
      expect(await tx.aliasLookup('Foo', '')).toBeNull()
    }, {scope: ChangeScope.BlockDefault})
  })
})

// ──── Single-workspace invariant ────

describe('single-workspace invariant', () => {
  it('throws WorkspaceMismatchError when a second write targets a different workspace', async () => {
    await expect(env.repo.tx(async tx => {
      await tx.create({id: 'ws-test-1', workspaceId: 'ws-A', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ws-test-2', workspaceId: 'ws-B', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(WorkspaceMismatchError)
    // Both rolled back.
    expect(env.cache.getSnapshot('ws-test-1')).toBeUndefined()
    expect(env.cache.getSnapshot('ws-test-2')).toBeUndefined()
  })

  it('pins workspaceId from the first write; meta.workspaceId visible to user fn', async () => {
    let observedWorkspace: string | null = null
    await env.repo.tx(async tx => {
      expect(tx.meta.workspaceId).toBeNull()
      await tx.create({id: 'pin-1', workspaceId: 'ws-X', parentId: null, orderKey: 'a0'})
      observedWorkspace = tx.meta.workspaceId
    }, {scope: ChangeScope.BlockDefault})
    expect(observedWorkspace).toBe('ws-X')

    // command_events captured the pin.
    const cmds = await env.commandEvents()
    expect(cmds.at(-1)!.workspace_id).toBe('ws-X')
  })
})

// ──── tx.afterCommit ────

describe('tx.afterCommit', () => {
  it('throws WorkspaceNotPinnedError when called before any write', async () => {
    await expect(env.repo.tx(async tx => {
      tx.afterCommit('test.afterCommitProbe', {fromBlockId: 'x'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(WorkspaceNotPinnedError)
  })

  it('throws ProcessorNotRegisteredError when the target name is unknown', async () => {
    await expect(env.repo.tx(async tx => {
      await tx.create({id: 'ac-unreg', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      tx.afterCommit('test.notRegistered', {fromBlockId: 'ac-unreg'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(ProcessorNotRegisteredError)
    // Tx rolled back — the create above is undone.
    expect(env.cache.getSnapshot('ac-unreg')).toBeUndefined()
  })

  it('schedules a job after a write has pinned workspaceId', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'ac-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      tx.afterCommit('test.afterCommitProbe', {fromBlockId: 'ac-1'}, {delayMs: 100})
    }, {scope: ChangeScope.BlockDefault})
    expect(env.cache.getSnapshot('ac-1')).toBeDefined()
  })

  it('does not run scheduled jobs on rollback', async () => {
    let dispatched = false
    await expect(env.repo.tx(async tx => {
      await tx.create({id: 'ac-roll', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      tx.afterCommit('test.afterCommitProbe', {fromBlockId: 'ac-roll'})
      dispatched = false
      throw new Error('boom')
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow('boom')
    expect(dispatched).toBe(false)
    // Block was never created (rollback).
    expect(env.cache.getSnapshot('ac-roll')).toBeUndefined()
  })
})

// ──── Read-only mode ────

describe('read-only mode', () => {
  it('rejects BlockDefault scope but allows local UiState and UserPrefs', async () => {
    const ro = await setup({isReadOnly: true})
    try {
      await expect(
        ro.repo.tx(tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}), {scope: ChangeScope.BlockDefault}),
      ).rejects.toThrow(ReadOnlyError)

      // UiState passes the gate. (Plugin mutators can use UiState to
      // mutate ephemeral chrome state in read-only workspaces.)
      const id = await ro.repo.tx(
        tx => tx.create({id: 'ui-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
        {scope: ChangeScope.UiState},
      )
      expect(id).toBe('ui-1')

      const prefId = await ro.repo.tx(
        tx => tx.create({id: 'prefs-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'}),
        {scope: ChangeScope.UserPrefs},
      )
      expect(prefId).toBe('prefs-1')

      // Both writes are tagged source='user' and enqueue to ps_crud.
      // In read-only workspaces the server will refuse these uploads
      // (RLS), and the rejection-quarantine surface lets the user see
      // and dismiss them. The earlier shape downgraded UserPrefs to
      // source='local-ephemeral' and silently skipped the upload; that
      // path is gone now.
      const cmds = await ro.commandEvents()
      expect(cmds.at(-1)).toMatchObject({scope: ChangeScope.UserPrefs, source: 'user'})
      const crud = await ro.psCrud()
      expect(crud.map(c => JSON.parse(c.data).id).sort()).toEqual(['prefs-1', 'ui-1'])
    } finally {
      // ro shares the file-level DB now — just drop its observer; the DB is
      // closed once in afterAll. (The next test's beforeEach resets the data.)
      ro.repo.stopSyncObserver()
    }
  })
})

// ──── Rollback semantics ────

describe('rollback', () => {
  it('throw inside fn rolls back SQL and discards snapshots; cache is unchanged', async () => {
    // Set up a known pre-state to verify cache is untouched.
    await env.repo.tx(
      tx => tx.create({id: 'rb-pre', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'pre'}),
      {scope: ChangeScope.BlockDefault},
    )
    const cacheBefore = env.cache.getSnapshot('rb-pre')!.content
    expect(cacheBefore).toBe('pre')

    await expect(env.repo.tx(async tx => {
      await tx.update('rb-pre', {content: 'mid-tx-write'})
      await tx.create({id: 'rb-new', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'})
      throw new Error('boom')
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow('boom')

    // Cache: untouched (mid-tx writes never reached the shared cache).
    expect(env.cache.getSnapshot('rb-pre')!.content).toBe('pre')
    expect(env.cache.getSnapshot('rb-new')).toBeUndefined()
    // SQL: rolled back.
    const got = await env.h.db.getOptional<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?', ['rb-pre'],
    )
    expect(got).toEqual({content: 'pre'})
    expect(await env.h.db.getOptional('SELECT id FROM blocks WHERE id = ?', ['rb-new'])).toBeNull()
    // command_events: only the pre-state tx, not the rolled-back one.
    const cmds = await env.commandEvents()
    expect(cmds.length).toBe(1)
  })

  it('resets tx_context after a rollback so the next tx is not mis-routed', async () => {
    await expect(env.repo.tx(async tx => {
      await tx.create({id: 'rb-ctx', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      throw new Error('boom')
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow('boom')

    // A leftover tx_id / source here would make the upload-routing and
    // workspace-invariant triggers mis-tag the NEXT transaction's writes
    // (e.g. a fresh local write looking like a sync apply).
    const ctx = await env.h.db.get<Record<string, unknown>>('SELECT * FROM tx_context')
    expect(ctx).toMatchObject({tx_id: null, user_id: null, scope: null, source: null})

    // The following successful tx still routes exactly one row to ps_crud,
    // proving the context was usable (not stuck) after the failure.
    const crudBefore = (await env.psCrud()).length
    await env.repo.tx(
      tx => tx.create({id: 'rb-after', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect((await env.psCrud()).length).toBe(crudBefore + 1)
  })
})

// ──── tx.run (composition) ────

describe('tx.run', () => {
  it('throws MutatorNotRegisteredError when the mutator is not in the registry snapshot', async () => {
    const orphan = defineMutator<{id: string}, void>({
      name: 'plugin:orphan',
      argsSchema: stringSchema(),
      scope: ChangeScope.BlockDefault,
      apply: async () => {},
    }) as Mutator
    await expect(env.repo.tx(
      tx => tx.run(orphan, {id: 'x'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(MutatorNotRegisteredError)
  })

  it('runs a registered mutator and threads writes into the same tx', async () => {
    const seedRoot = defineMutator<{id: string}, void>({
      name: 'test:seedRoot',
      argsSchema: stringSchema(),
      scope: ChangeScope.BlockDefault,
      apply: async (tx, args) => {
        await tx.create({id: args.id, workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'from-mutator'})
      },
    }) as Mutator
    env.repo.__setMutatorsForTesting([seedRoot])
    await env.repo.tx(tx => tx.run(seedRoot, {id: 'mut-1'}), {scope: ChangeScope.BlockDefault})
    expect(env.cache.getSnapshot('mut-1')!.content).toBe('from-mutator')
  })

  it('rejects scope mismatch between tx and sub-mutator', async () => {
    const uiOnly = defineMutator<{id: string}, void>({
      name: 'test:uiOnly',
      argsSchema: stringSchema(),
      scope: ChangeScope.UiState,
      apply: async () => {},
    }) as Mutator
    env.repo.__setMutatorsForTesting([uiOnly])
    await expect(env.repo.tx(
      tx => tx.run(uiOnly, {id: 'x'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(/scope mismatch/)
  })
})

// ──── command_events + tx_context cleanup ────

describe('commit pipeline bookkeeping', () => {
  it('writes one command_events row per repo.tx and clears tx_context', async () => {
    await env.repo.tx(async tx => {
      await tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault, description: 'first'})
    await env.repo.tx(async tx => {
      await tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault, description: 'second'})

    const cmds = await env.commandEvents()
    expect(cmds.length).toBe(2)
    expect(new Set(cmds.map(c => c.tx_id)).size).toBe(2)  // distinct tx ids

    // After both txs, tx_context is back to NULL.
    const ctx = await env.h.db.get<Record<string, unknown>>('SELECT * FROM tx_context')
    expect(ctx).toMatchObject({tx_id: null, user_id: null, scope: null, source: null})
  })

  it('UiState scope tags command_events.source as user and enqueues to ps_crud', async () => {
    // Phase 2 collapsed the routing distinction: every repo.tx write is
    // source='user'. The UiState identity still matters (undo bucketing,
    // requireSchemaScope), but uploads happen the same way as
    // BlockDefault. Server-side refusal lands in ps_crud_rejected.
    await env.repo.tx(async tx => {
      await tx.create({id: 'ui-state-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.UiState})

    const cmds = await env.commandEvents()
    expect(cmds.at(-1)!.source).toBe('user')
    const crud = await env.psCrud()
    expect(crud).toHaveLength(1)
    expect(JSON.parse(crud[0].data)).toMatchObject({op: 'PUT', type: 'blocks', id: 'ui-state-1'})
  })

  it('UserPrefs scope uploads in writable repos', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'prefs-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.UserPrefs})

    const cmds = await env.commandEvents()
    expect(cmds.at(-1)).toMatchObject({scope: ChangeScope.UserPrefs, source: 'user'})
    const crud = await env.psCrud()
    expect(crud).toHaveLength(1)
    expect(JSON.parse(crud[0].data)).toMatchObject({op: 'PUT', type: 'blocks', id: 'prefs-1'})
  })

  it('multi-create tx ships as one CrudTransaction (ps_crud.tx_id groups across rows)', async () => {
    // Two creates inside one repo.tx must share ps_crud.tx_id so
    // PowerSync's getNextCrudTransaction() emits them as one
    // CrudTransaction. NULL tx_id (or distinct per-row tx_id) would
    // ship them as separate server-side txs — atomicity intent lost.
    await env.repo.tx(async tx => {
      await tx.create({id: 'gx-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
      await tx.create({id: 'gx-2', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})

    const crud = await env.h.db.getAll<{id: number; tx_id: number | null; data: string}>(
      'SELECT id, tx_id, data FROM ps_crud ORDER BY id',
    )
    expect(crud).toHaveLength(2)
    // Both rows non-null tx_id and matching.
    expect(crud[0].tx_id).not.toBeNull()
    expect(crud[1].tx_id).toBe(crud[0].tx_id)
    // Distinct envelopes.
    expect(new Set(crud.map(r => JSON.parse(r.data).id))).toEqual(new Set(['gx-1', 'gx-2']))

    // Run a second tx — its rows must get a different tx_id (so the
    // server treats them as a separate CrudTransaction).
    await env.repo.tx(async tx => {
      await tx.create({id: 'gx-3', workspaceId: 'ws-1', parentId: null, orderKey: 'a2'})
    }, {scope: ChangeScope.BlockDefault})
    const allCrud = await env.h.db.getAll<{tx_id: number | null}>(
      'SELECT tx_id FROM ps_crud ORDER BY id',
    )
    expect(allCrud[2].tx_id).not.toBeNull()
    expect(allCrud[2].tx_id).not.toBe(crud[0].tx_id)
  })
})
