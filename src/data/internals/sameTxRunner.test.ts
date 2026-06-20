// @vitest-environment node
/**
 * Same-tx processor runner unit tests. Pins the in-tx pass that
 * lives inside `runTx` between user-fn-return and command_events
 * insert. Distinct from `processorRunner.test.ts` because the
 * runtime model is structurally different: same-tx fires inside
 * `db.writeTransaction`, can amend writes, and can throw to roll
 * back.
 *
 * Coverage:
 *   - Field-watching: fires when watched field changes; aggregates
 *     changedRows; skips when only unwatched fields changed
 *   - Amend: a same-tx processor writing via ctx.tx amends the
 *     user's tx; later processors see the amended state
 *   - Atomic rollback: throw inside apply rolls back the whole
 *     user tx (no rows committed, no undo entry, no snapshots
 *     visible to outside-tx readers)
 *   - ProcessorRejection class roundtrips through the throw —
 *     callers can `instanceof` and read `code` / `meta`
 *   - Ordering: registration order is preserved (later processors
 *     see earlier processors' amendments)
 *   - Field-match recomputation: a processor that amends a watched
 *     field updates the state for subsequent processors but does
 *     NOT re-fire itself (single pass)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  ProcessorRejection,
  type AnySameTxProcessor,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../repo'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
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
  })
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// Dispose the per-test Repo's sync observer so its db.onChange subscription
// doesn't leak onto the shared DB (closed once in afterAll).
afterEach(() => { env.repo.stopSyncObserver() })

interface FireLog {
  events: Array<{name: string; ids: string[]; afterContents: Array<string | null>}>
}

const recording = (
  name: string,
  fields: ('content' | 'properties' | 'references')[],
  log: FireLog,
  extra?: (
    ctx: {tx: import('@/data/api').Tx},
    event: import('@/data/api').SameTxEvent,
  ) => Promise<void>,
): AnySameTxProcessor => ({
  name,
  watches: {kind: 'field', table: 'blocks', fields},
  apply: async (event, ctx) => {
    log.events.push({
      name,
      ids: event.changedRows.map(r => r.id),
      afterContents: event.changedRows.map(r => r.after?.content ?? null),
    })
    if (extra) await extra(ctx, event)
  },
})

describe('Same-tx runner — field-watching dispatch', () => {
  it('fires once per tx with the aggregated changedRows when a watched field changes', async () => {
    const log: FireLog = {events: []}
    env.repo.__setSameTxProcessorsForTesting([
      recording('test.contentWatcher', ['content'], log),
    ])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo'})
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'bar'})
    }, {scope: ChangeScope.BlockDefault})

    expect(log.events).toHaveLength(1)
    expect(new Set(log.events[0].ids)).toEqual(new Set(['a', 'b']))
  })

  it('does not fire when only an unwatched field changed', async () => {
    const log: FireLog = {events: []}
    env.repo.__setSameTxProcessorsForTesting([
      recording('test.refsWatcher', ['references'], log),
    ])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo'})
    }, {scope: ChangeScope.BlockDefault})

    // insert does change every field (incl. references) → fires
    expect(log.events).toHaveLength(1)
    log.events.length = 0

    // content-only update should NOT fire a references watcher
    await env.repo.tx(async tx => {
      await tx.update('a', {content: 'updated'})
    }, {scope: ChangeScope.BlockDefault})

    expect(log.events).toHaveLength(0)
  })
})

describe('Same-tx runner — event dispatch', () => {
  it('fires event watchers inside the active tx with read-your-own-writes DB access', async () => {
    const seenPayloads: unknown[] = []
    const watcher: AnySameTxProcessor = {
      name: 'test.eventWatcher',
      watches: {kind: 'event', events: ['test.blockTouched']},
      apply: async (event, ctx) => {
        seenPayloads.push(...event.emittedEvents.map(e => e.payload))
        const row = await ctx.db.get<{content: string}>(
          'SELECT content FROM blocks WHERE id = ?',
          ['a'],
        )
        await ctx.tx.update('a', {content: `${row.content} event`}, {skipMetadata: true})
      },
    }
    env.repo.__setSameTxProcessorsForTesting([watcher])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'start'})
      tx.emitEvent('test.blockTouched', {id: 'a'})
    }, {scope: ChangeScope.BlockDefault})

    expect(seenPayloads).toEqual([{id: 'a'}])
    const row = await env.h.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?',
      ['a'],
    )
    expect(row.content).toBe('start event')
  })

  it('does not fire event watchers when their event was not emitted', async () => {
    const log: FireLog = {events: []}
    const watcher: AnySameTxProcessor = {
      name: 'test.eventWatcher',
      watches: {kind: 'event', events: ['test.missing']},
      apply: async () => {
        log.events.push({name: 'test.eventWatcher', ids: [], afterContents: []})
      },
    }
    env.repo.__setSameTxProcessorsForTesting([watcher])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'start'})
      tx.emitEvent('test.other', {id: 'a'})
    }, {scope: ChangeScope.BlockDefault})

    expect(log.events).toHaveLength(0)
  })
})

describe('Same-tx runner — amend semantics', () => {
  it('processor amendments are visible to later processors in the same pass', async () => {
    const log: FireLog = {events: []}

    // First processor sets content to "AMENDED" via tx.update.
    const amender: AnySameTxProcessor = {
      name: 'test.amender',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async (event, ctx) => {
        for (const row of event.changedRows) {
          if (row.after && row.after.content !== 'AMENDED') {
            await ctx.tx.update(row.id, {content: 'AMENDED'}, {skipMetadata: true})
          }
        }
      },
    }

    env.repo.__setSameTxProcessorsForTesting([
      amender,
      // Observer runs after — its event.changedRows should show
      // the amended `after.content`.
      recording('test.observer', ['content'], log),
    ])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'original'})
    }, {scope: ChangeScope.BlockDefault})

    expect(log.events).toHaveLength(1)
    expect(log.events[0].afterContents).toEqual(['AMENDED'])

    // Committed state reflects the amendment.
    const final = await env.h.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', ['a'])
    expect(final.content).toBe('AMENDED')
  })

  it('amendments commit atomically with the user tx (one undo entry)', async () => {
    const amender: AnySameTxProcessor = {
      name: 'test.amender',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async (event, ctx) => {
        for (const row of event.changedRows) {
          if (row.after && !row.after.content.endsWith(' [touched]')) {
            await ctx.tx.update(row.id, {content: `${row.after.content} [touched]`}, {skipMetadata: true})
          }
        }
      },
    }
    env.repo.__setSameTxProcessorsForTesting([amender])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo'})
    }, {scope: ChangeScope.BlockDefault})

    // One BlockDefault undo entry covers both writes.
    const depths = env.repo.undoManager.depths(ChangeScope.BlockDefault)
    expect(depths.undo).toBe(1)

    // Undoing reverts both atomically.
    await env.repo.undo(ChangeScope.BlockDefault)
    const row = await env.h.db.getOptional<{id: string}>('SELECT id FROM blocks WHERE id = ? AND deleted = 0', ['a'])
    expect(row).toBeNull()
  })
})

describe('Same-tx runner — rejection semantics', () => {
  it('throwing rolls back the whole user tx atomically (no rows committed)', async () => {
    const rejector: AnySameTxProcessor = {
      name: 'test.rejector',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async () => {
        throw new ProcessorRejection('rejected by test', 'test.code', {detail: 42})
      },
    }
    env.repo.__setSameTxProcessorsForTesting([rejector])

    let caught: unknown
    try {
      await env.repo.tx(async tx => {
        await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo'})
      }, {scope: ChangeScope.BlockDefault})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('test.code')
    expect((caught as ProcessorRejection).meta).toEqual({detail: 42})

    // Row did not commit — outside-tx read sees no block.
    const row = await env.h.db.getOptional<{id: string}>('SELECT id FROM blocks WHERE id = ?', ['a'])
    expect(row).toBeNull()

    // No undo entry recorded.
    expect(env.repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(0)
  })

  it('plain Error throws also roll back (not just ProcessorRejection)', async () => {
    const thrower: AnySameTxProcessor = {
      name: 'test.thrower',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async () => { throw new Error('boom') },
    }
    env.repo.__setSameTxProcessorsForTesting([thrower])

    await expect(env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow('boom')

    const row = await env.h.db.getOptional<{id: string}>('SELECT id FROM blocks WHERE id = ?', ['a'])
    expect(row).toBeNull()
  })
})

describe('Same-tx runner — ordering', () => {
  it('preserves registration order', async () => {
    const log: FireLog = {events: []}
    env.repo.__setSameTxProcessorsForTesting([
      recording('a', ['content'], log),
      recording('b', ['content'], log),
      recording('c', ['content'], log),
    ])

    await env.repo.tx(async tx => {
      await tx.create({id: '1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
    }, {scope: ChangeScope.BlockDefault})

    expect(log.events.map(e => e.name)).toEqual(['a', 'b', 'c'])
  })

  it('a processor does NOT re-fire on its own amendments (single pass)', async () => {
    const log: FireLog = {events: []}
    const selfAmending: AnySameTxProcessor = {
      name: 'test.selfAmend',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async (event, ctx) => {
        log.events.push({
          name: 'test.selfAmend',
          ids: event.changedRows.map(r => r.id),
          afterContents: event.changedRows.map(r => r.after?.content ?? null),
        })
        for (const row of event.changedRows) {
          if (row.after && row.after.content !== 'final') {
            await ctx.tx.update(row.id, {content: 'final'}, {skipMetadata: true})
          }
        }
      },
    }
    env.repo.__setSameTxProcessorsForTesting([selfAmending])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'start'})
    }, {scope: ChangeScope.BlockDefault})

    // Fired exactly once even though it amended a watched field.
    expect(log.events).toHaveLength(1)

    // Amendment still landed.
    const row = await env.h.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', ['a'])
    expect(row.content).toBe('final')
  })
})

describe('Same-tx runner — undo/redo replay skip (#187)', () => {
  // A value-deriving same-tx processor: appends '!' to content whenever
  // content changes (and isn't already suffixed). Non-idempotent in the
  // sense that re-running on a restore would corrupt the restored value.
  const appendBang: AnySameTxProcessor = {
    name: 'test.appendBang',
    watches: {kind: 'field', table: 'blocks', fields: ['content']},
    apply: async (event, ctx) => {
      for (const row of event.changedRows) {
        if (row.after && !row.after.content.endsWith('!')) {
          await ctx.tx.update(row.id, {content: `${row.after.content}!`}, {skipMetadata: true})
        }
      }
    },
  }

  it('does not re-run a value-deriving same-tx processor during undo/redo (restore is exact)', async () => {
    // Seed content='orig' BEFORE registering the processor, so the
    // restored snapshot is the bare 'orig' (no '!' suffix). This is
    // what makes the bug observable: if the same-tx pass re-ran on the
    // undo's applyRaw write, 'orig' (no trailing '!') would be amended
    // to 'orig!'.
    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'orig'})
    }, {scope: ChangeScope.BlockDefault})

    env.repo.__setSameTxProcessorsForTesting([appendBang])

    // Update to 'changed' → processor appends → 'changed!'. The undo
    // entry for this tx captures before={content:'orig'},
    // after={content:'changed!'}.
    await env.repo.tx(async tx => {
      await tx.update('a', {content: 'changed'})
    }, {scope: ChangeScope.BlockDefault})
    const changed = await env.h.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', ['a'])
    expect(changed.content).toBe('changed!')

    // Undo: applyRaw drives content back to exactly 'orig'. That's a
    // content change in the replay tx, so a non-gated same-tx pass
    // would re-derive to 'orig!'. With the replay-skip gate it stays
    // 'orig' (#187).
    expect(await env.repo.undo(ChangeScope.BlockDefault)).toBe(true)
    const undone = await env.h.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', ['a'])
    expect(undone.content).toBe('orig')

    // Redo: applyRaw restores the post-update snapshot exactly.
    expect(await env.repo.redo(ChangeScope.BlockDefault)).toBe(true)
    const redone = await env.h.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', ['a'])
    expect(redone.content).toBe('changed!')
  })
})

describe('Same-tx runner — zero-write tx', () => {
  it('skips dispatch when no writes happened', async () => {
    const log: FireLog = {events: []}
    env.repo.__setSameTxProcessorsForTesting([
      recording('test.observer', ['content'], log),
    ])

    await env.repo.tx(async () => {
      // No writes — workspaceId stays null, snapshots empty.
    }, {scope: ChangeScope.BlockDefault})

    expect(log.events).toHaveLength(0)
  })
})
