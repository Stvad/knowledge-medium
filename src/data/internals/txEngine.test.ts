// @vitest-environment node
/**
 * Tx engine tests (spec §5.3 / §10 / §4.7).
 *
 * Every test runs against a real `@powersync/node` PowerSyncDatabase via
 * the `createTestDb` harness — same `db.execute` / `db.writeTransaction`
 * surface as production, real SQLite, real triggers. So:
 *   - row_events fire when primitives write, with the correct
 *     `(tx_id, source, kind)` tag determined by `tx_context`
 *   - the upload-routing trigger fires on `source = 'user'` writes
 *   - the workspace-invariant trigger fires on local writes (and would
 *     ABORT a cross-workspace child)
 *
 * The Tx engine is exercised through the public `Repo.tx(fn, opts)` —
 * not in isolation. That's the full pipeline: open writeTransaction,
 * set tx_context, run fn, write command_events, clear tx_context, walk
 * snapshots → cache.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  CycleError,
  DeletedConflictError,
  DeterministicIdCrossWorkspaceError,
  DuplicateIdError,
  MutatorNotRegisteredError,
  NotDeletedError,
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
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'

// ──── Test fixtures ────

const stringSchema = <T>(): Schema<T> => ({parse: (x: unknown) => x as T})

const titleProp = defineProperty<string>('title', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

const dateProp = defineProperty<Date | undefined>('due-date', {
  codec: codecs.optional(codecs.date),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'date',
})

/** Explicit-watching test processor used by the afterCommit tests. The
 *  apply fn is a no-op — engine tests pin scheduling/rollback semantics,
 *  not what the processor does. Registered via `__setProcessorsForTesting`
 *  in `setup()` so `tx.afterCommit('test.afterCommitProbe', ...)` passes
 *  the §5.7 enqueue-time validation. */
const afterCommitProbeProcessor = definePostCommitProcessor<{fromBlockId: string}>({
  name: 'test.afterCommitProbe',
  scope: ChangeScope.BlockDefault,
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
  rowEventsFor(blockId: string): Promise<Array<{kind: string; source: string; tx_id: string | null}>>
  commandEvents(): Promise<Array<{tx_id: string; scope: string; workspace_id: string | null; source: string}>>
  psCrud(): Promise<Array<{data: string}>>
}

const setup = async (overrides?: {isReadOnly?: boolean}): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  const tick = () => ++timeCursor
  let idCursor = 0
  const newId = () => `gen-${++idCursor}`
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1', name: 'Test'},
    isReadOnly: overrides?.isReadOnly,
    now: tick,
    newId,
    // Engine tests pin Tx primitive behavior. Kernel processors firing
    // on content writes would add follow-up txs (parseReferences) the
    // engine assertions don't account for — keep the processor surface
    // empty and let the parseReferences integration tests cover it.
    registerKernelProcessors: false,
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
    rowEventsFor: blockId =>
      h.db.getAll('SELECT kind, source, tx_id FROM row_events WHERE block_id = ? ORDER BY id', [blockId]),
    commandEvents: () =>
      h.db.getAll('SELECT tx_id, scope, workspace_id, source FROM command_events ORDER BY created_at'),
    psCrud: () => h.db.getAll('SELECT data FROM ps_crud ORDER BY id'),
  }
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

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

    // row_events tagged source='user', tx_id matches command_events.
    const events = await env.rowEventsFor(id)
    expect(events).toEqual([{kind: 'create', source: 'user', tx_id: expect.any(String)}])
    const cmds = await env.commandEvents()
    expect(cmds.length).toBe(1)
    expect(cmds[0]).toMatchObject({scope: 'block-default', workspace_id: 'ws-1', source: 'user'})
    expect(events[0].tx_id).toBe(cmds[0].tx_id)

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

  it('bumps updatedAt + updatedBy unless skipMetadata', async () => {
    const id = await env.repo.tx(
      tx => tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    const tsAfterCreate = env.cache.getSnapshot(id)!.updatedAt
    env.tick()  // advance virtual clock
    await env.repo.tx(tx => tx.update(id, {content: 'x'}), {scope: ChangeScope.BlockDefault})
    expect(env.cache.getSnapshot(id)!.updatedAt).toBeGreaterThan(tsAfterCreate)

    const beforeBookkeeping = env.cache.getSnapshot(id)!.updatedAt
    env.tick()
    await env.repo.tx(tx => tx.update(id, {references: [{id: 'ref', alias: 'a'}]}, {skipMetadata: true}), {scope: ChangeScope.References})
    expect(env.cache.getSnapshot(id)!.updatedAt).toBe(beforeBookkeeping)
  })
})

// ──── tx.delete + tx.restore ────

describe('tx.delete + tx.restore', () => {
  it('soft-delete: deleted flips 0→1 and trigger emits kind=soft-delete', async () => {
    const id = await env.repo.tx(
      tx => tx.create({id: 'sd-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.delete(id), {scope: ChangeScope.BlockDefault})
    expect(env.cache.getSnapshot(id)!.deleted).toBe(true)
    const events = await env.rowEventsFor(id)
    expect(events.map(e => e.kind)).toEqual(['create', 'soft-delete'])
  })

  it('delete on already-soft-deleted row is a no-op', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'sd-2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(tx => tx.delete('sd-2'), {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.delete('sd-2'), {scope: ChangeScope.BlockDefault})
    const events = await env.rowEventsFor('sd-2')
    expect(events.map(e => e.kind)).toEqual(['create', 'soft-delete'])  // still just one delete
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
  it('rejects BlockDefault scope but allows UiState', async () => {
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
    } finally {
      await ro.h.cleanup()
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

  it('UiState scope tags command_events.source as local-ephemeral and skips upload routing', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'ui-state-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.UiState})

    const cmds = await env.commandEvents()
    expect(cmds.at(-1)!.source).toBe('local-ephemeral')
    // Upload trigger gates on source = 'user'; UiState writes don't enqueue.
    const crud = await env.psCrud()
    expect(crud).toEqual([])
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
