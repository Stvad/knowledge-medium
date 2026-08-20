// @vitest-environment node
/**
 * The properties-as-blocks cell → children pass: what it migrates, what it
 * refuses to touch, and that a killed run picks up where it left off without
 * any progress state to go stale.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, seedProperty } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { WorkspaceBackfillContext } from '@/data/facets'
import {
  CANDIDATE_SQL, PROPERTY_CELL_BACKFILL_ID, ROWS_PER_KEY, TARGET_INSERT_ROWS,
  onPropertyCellBackfillProgress, runPropertyCellBackfill,
} from './propertyCellBackfill'

const WS = 'ws-cell-backfill'

const noteProp = seedProperty({
  seedKey: 'test/property/note',
  revision: 1,
  name: 'demo:note',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const extraProp = seedProperty({
  seedKey: 'test/property/extra',
  revision: 1,
  name: 'demo:extra',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(noteProp, {source: 'test'}),
    definitionSeedsFacet.of(extraProp, {source: 'test'}),
  ], {repo, workspaceId: WS, safeMode: false}))
})

const create = async (id: string, properties: Record<string, unknown>) => {
  await repo.tx(async tx => {
    await tx.create({
      id, workspaceId: WS, parentId: null, orderKey: `k-${id}`,
      content: id, properties,
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
}

/** Enough blocks to span two write batches, derived from the budget rather than
 *  written as a literal: a fixed count silently stops crossing a boundary if the
 *  budget ever moves, and nothing would fail. */
const TWO_BATCHES = TARGET_INSERT_ROWS / ROWS_PER_KEY + 10

/** `count` blocks, each carrying one registered cell key. One transaction, not
 *  one per block: the pass batches on inserted ROWS and reads cells off
 *  `blocks`, so the seed's transaction grain changes nothing here. */
const seedNotes = async (count: number) => {
  const ids = Array.from({length: count}, (_, i) => `b${String(i).padStart(4, '0')}`)
  await repo.tx(async tx => {
    for (const id of ids) {
      await tx.create({
        id, workspaceId: WS, parentId: null, orderKey: `k-${id}`,
        content: id, properties: {'demo:note': id},
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
  return ids
}

const run = async () => repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)

/** The runner's context, rebuilt for tests that need to act BETWEEN batches.
 *  Same shape the runner passes, minus its per-transaction preconditions —
 *  those are the runner's own tests. */
const makeCtx = (): WorkspaceBackfillContext => {
  const resolver = repo.propertySchemaResolverFor(WS)
  return {
    workspaceId: WS,
    getAll: (sql, params) => repo.db.getAll(sql, params as unknown[] | undefined),
    tx: (fn, opts) => repo.tx(fn, {scope: ChangeScope.BlockDefault, skipUndo: true, ...opts}),
    resolveNameSchema: name => {
      const resolution = resolver.resolve(name)
      return resolution.status === 'resolved' ? resolution.schema : undefined
    },
    resolveFieldSchema: fieldId => {
      const resolution = resolver.resolveField(fieldId)
      return resolution.status === 'resolved' ? resolution.schema : undefined
    },
  }
}

/** Field rows under `parentId`, with the value rows beneath each. */
const fieldRowsOf = async (parentId: string) => {
  const fields = await repo.db.getAll<{id: string; content: string}>(
    `SELECT id, content FROM blocks
      WHERE parent_id = ? AND workspace_id = ? AND deleted = 0 AND is_field_form = 1
      ORDER BY order_key, id`,
    [parentId, WS],
  )
  return Promise.all(fields.map(async field => ({
    ...field,
    values: (await repo.db.getAll<{content: string}>(
      `SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id`,
      [field.id],
    )).map(row => row.content),
  })))
}

/** Blocks the pass created, workspace-wide. */
const fieldRowCount = async (): Promise<number> => (await repo.db.get<{n: number}>(
  `SELECT COUNT(*) AS n FROM blocks
    WHERE workspace_id = ? AND deleted = 0 AND is_field_form = 1`, [WS],
))!.n

// The four `seedNotes` tests are the only slow ones here; the rest are
// milliseconds. Measured at load avg ~170 on 12 cores: ~0.3-0.45s solo, 0.4-1.6s
// under `vitest run src/data/internals/`, 0.6-1.2s under the full gate. Before
// the seed batching the same four hit 5.2-5.9s on a gate run — over vitest's
// 5000ms default, which is #633 and #639. Cost tracks ambient load more than the
// work, so 30s is set well above the range rather than tuned to it; re-measure
// under a named condition before trusting any single figure here.
describe('property cell → children backfill', {timeout: 30_000}, () => {
  it('gives a registered cell key its field row and value row', async () => {
    await create('b1', {'demo:note': 'hello'})

    expect((await run()).outcome).toBe('ran')

    const fields = await fieldRowsOf('b1')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.values).toEqual(['hello'])
    // The cell is untouched — this pass ADDS the child representation, it does
    // not move the value. The workspace reads children only once it flips.
    expect((await repo.load('b1'))?.properties['demo:note']).toBe('hello')
  })

  it('leaves an unregistered key in the cell rather than inventing a definition', async () => {
    // Nothing declares this name, so no schema can back a field row. Deleting
    // or synthesizing here would be the pass making up data; the key stays
    // cell-only and `audit-properties` is what reports it.
    await create('b1', {'demo:nobody-declares-this': 'x'})

    expect((await run()).outcome).toBe('ran')

    expect(await fieldRowsOf('b1')).toEqual([])
    expect((await repo.load('b1'))?.properties['demo:nobody-declares-this']).toBe('x')
  })

  it('reports an idle workspace as caught up, not merely converged', async () => {
    await create('b1', {'demo:note': 'hello'})
    await runPropertyCellBackfill(makeCtx())

    expect((await runPropertyCellBackfill(makeCtx())).editedUnderPass).toBe(false)
  })

  it('is a fixpoint — a second sweep of an already-migrated graph writes nothing', async () => {
    await create('b1', {'demo:note': 'hello'})
    await run()
    const after = await fieldRowCount()

    expect((await run()).outcome).toBe('ran')

    expect(await fieldRowCount()).toBe(after)
    expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['hello'])
  })

  it('picks up where a killed run stopped, with no progress state to consult', async () => {
    // Resumability is derived from the data: the candidate query asks which
    // blocks still owe children. Simulated by migrating one block, then
    // dropping the claim as a crash would leave it.
    await create('b1', {'demo:note': 'one'})
    await create('b2', {'demo:note': 'two'})
    await run()

    // A third block appears after the "crash" — the resumed run has to find it
    // without re-materializing the first two.
    await create('b3', {'demo:note': 'three'})
    expect((await run()).outcome).toBe('ran')

    expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['one'])
    expect((await fieldRowsOf('b2'))[0]!.values).toEqual(['two'])
    expect((await fieldRowsOf('b3'))[0]!.values).toEqual(['three'])
    expect(await fieldRowCount()).toBe(3)
  })

  it('migrates past a batch boundary instead of stopping at the first page', async () => {
    // Two write batches, not one: the pass drains a fetched page in
    // TARGET_INSERT_ROWS-sized chunks, so a chunk that abandons the remainder,
    // or a cursor advanced past unvisited rows, leaves blocks cell-only — and
    // the claim would then record the migration as complete. A whole SCAN_PAGE
    // still fits here, so cursor resume ACROSS pages is not exercised.
    const ids = await seedNotes(TWO_BATCHES)
    const batchSizes: number[] = []
    const off = onPropertyCellBackfillProgress(p => batchSizes.push(p.blocksScanned))

    const result = await run()
    off()

    expect(result.outcome).toBe('ran')
    expect(await fieldRowCount()).toBe(ids.length)
    // TWO_BATCHES follows the budget's VALUE; this pins the batching RULE it
    // assumes. Drop the ROWS_PER_KEY factor from the drain loop — a real bug,
    // doubling every transaction — and the fixture collapses to one batch: this
    // test stops crossing a boundary, and the whole file still passes.
    expect(batchSizes[0]).toBeLessThan(ids.length)
  })

  it('reports a block whose cell value cannot be decoded and migrates the rest', async () => {
    // A legacy raw `tx.update({properties})` can leave a value the schema's
    // codec rejects. The materializer REFUSES such a write — right for a live
    // edit, fatal for a sweep if it escaped, since one bad value would abort
    // the migration for the whole graph.
    await create('good', {'demo:note': 'fine'})
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = ? WHERE id = ?`,
      [JSON.stringify({'demo:note': {not: 'a string'}}), 'good'],
    )
    await create('alsogood', {'demo:note': 'also fine'})

    expect((await run()).outcome).toBe('ran')

    expect((await fieldRowsOf('alsogood'))[0]!.values).toEqual(['also fine'])
    expect(await fieldRowsOf('good')).toEqual([])
  })

  it('revisits a block edited behind the cursor, which one sweep can never see', async () => {
    // The cursor only moves forward, so a property written to an
    // already-visited block mid-pass is invisible to the rest of that sweep —
    // and completion is recorded once per graph, so "invisible" would mean
    // "never". A second sweep is what makes the pass a fixpoint rather than a
    // single ordered walk. Driven directly so the concurrent edit lands at a
    // known point: after the first committed batch.
    const ids = await seedNotes(TWO_BATCHES)

    let edited = false
    const progress = await runPropertyCellBackfill(makeCtx(), async () => {
      if (edited) return
      edited = true
      await repo.tx(async tx => {
        await tx.update(ids[0]!, {properties: {'demo:note': ids[0], 'demo:extra': 'added'}})
      }, {scope: ChangeScope.BlockDefault, description: 'concurrent user edit'})
    })

    expect(edited).toBe(true)
    // Three, where an unedited graph of the same size takes two: sweep 1 walks
    // it, sweep 2 picks up the key added behind the cursor, sweep 3 converges.
    // `> 1` would hold for any non-empty graph and so says nothing about the edit.
    expect(progress.sweeps).toBe(3)
    expect(await fieldRowsOf(ids[0]!)).toHaveLength(2)
  })

  it('migrates an owner whose existing field row belongs to a different property', async () => {
    // The predicate this replaced compared key COUNT against field-row count,
    // which is not an over-approximation: one cell key plus one unrelated
    // field row cancel out, and the owner drops out of the candidate set with
    // its key still unmigrated — permanently, once completion is recorded.
    await create('b1', {'demo:note': 'mine'})
    await repo.tx(async tx => {
      await tx.create({
        id: 'stray-field', workspaceId: WS, parentId: 'b1', orderKey: 'a0',
        content: '::((00000000-0000-4000-8000-000000000000))',
        referenceTargetId: '00000000-0000-4000-8000-000000000000',
        isFieldForm: true,
      })
    }, {scope: ChangeScope.BlockDefault, description: 'unrelated field row'})

    expect((await run()).outcome).toBe('ran')

    const values = (await fieldRowsOf('b1')).flatMap(field => field.values)
    expect(values).toContain('mine')
  })

  it('removes the children of a key deleted while the pass was running', async () => {
    // Pre-flip nothing else deletes them — the live processor is dormant — so
    // children left behind become authoritative at the flip and RESURRECT a
    // property the user removed. The materializer can delete them, but only
    // if the pass names the key, and the cell no longer does.
    await create('b1', {'demo:note': 'gone soon'})
    await runPropertyCellBackfill(makeCtx())
    expect(await fieldRowsOf('b1')).toHaveLength(1)

    await repo.tx(async tx => {
      await tx.update('b1', {properties: {'demo:extra': 'still here'}})
    }, {scope: ChangeScope.BlockDefault, description: 'user deletes a property'})

    await runPropertyCellBackfill(makeCtx())

    const fields = await fieldRowsOf('b1')
    expect(fields.flatMap(f => f.values)).toEqual(['still here'])
  })

  it('repairs a value edited behind the cursor, not just a key added there', async () => {
    // The behind-cursor case for an EXISTING key: the block was visited, then
    // its value changed. Post-flip the child is what the cell gets rebuilt
    // from, so a stale child is the user's edit being reverted.
    const ids = await seedNotes(TWO_BATCHES)

    let edited = false
    const progress = await runPropertyCellBackfill(makeCtx(), async () => {
      if (edited) return
      edited = true
      await repo.tx(async tx => {
        await tx.update(ids[0]!, {properties: {'demo:note': 'edited after the visit'}})
      }, {scope: ChangeScope.BlockDefault, description: 'concurrent value edit'})
    })

    // Two, unlike the added-key case above: a rewritten value changes no child
    // COUNT, so the sweep that repairs it is also the one that converges.
    // Counting a rewrite as unconverged is the regression that cost a whole
    // extra sweep per open editor.
    expect(progress.sweeps).toBe(2)
    expect((await fieldRowsOf(ids[0]!))[0]!.values).toEqual(['edited after the visit'])
  })

  describe('past the flip', () => {
    /** Mark the workspace child-backed. Raw, because that is how the column
     *  arrives: it is written server-side and synced, never through the tx
     *  layer — which is also why the pass has to re-read it per batch. */
    const flip = async () => {
      await sharedDb.db.execute(
        `INSERT INTO workspaces
           (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary,
            properties_migration)
         VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
        [WS, 'flipped ws', 'user-1'])
    }

    /** Overwrite a cell without going through the tx layer — post-flip a
     *  `repo.tx` property write dual-writes children, which is the opposite of
     *  the divergence these tests need. Also the shape a sync arrival has. */
    const rawCell = async (id: string, properties: Record<string, unknown>) => {
      await sharedDb.db.execute(
        `UPDATE blocks SET properties_json = ? WHERE id = ?`,
        [JSON.stringify(properties), id])
    }

    it('fills in a cell key that has no field row yet', async () => {
      // The whole point of flip-then-backfill. Post-flip a cell key with NO
      // children is the one shape the cell is still the truth for (§5's
      // pending-materialization rule), so materializing it is exactly what
      // "backfill the history" means and nothing authoritative is at risk.
      await create('b1', {'demo:note': 'hello'})
      await flip()

      expect((await run()).outcome).toBe('ran')

      expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['hello'])
    })

    it('leaves an existing value row alone when the cell disagrees with it', async () => {
      // Past the flip the children are the property truth and the cell is a
      // local derived surface — a device that received value rows from sync
      // and has not re-projected them holds exactly this shape. Reconciling
      // from the cell here overwrites a real value with a stale bag.
      await create('b1', {'demo:note': 'authoritative'})
      await runPropertyCellBackfill(makeCtx())
      await flip()
      await rawCell('b1', {'demo:note': 'stale'})

      await runPropertyCellBackfill(makeCtx())

      expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['authoritative'])
    })

    it('does not delete the children of a key the cell no longer carries', async () => {
      // Pre-flip the name list is the cell's keys UNION the ones the existing
      // field rows stand for, so a key only the CHILDREN have is named and its
      // children are removed. Post-flip that same union tombstones a value row
      // the cell simply has not caught up to.
      await create('b1', {'demo:note': 'kept', 'demo:extra': 'also kept'})
      await runPropertyCellBackfill(makeCtx())
      expect(await fieldRowsOf('b1')).toHaveLength(2)
      await flip()
      await rawCell('b1', {'demo:note': 'kept'})

      await runPropertyCellBackfill(makeCtx())

      expect(await fieldRowsOf('b1')).toHaveLength(2)
    })

    it('converges while ordinary editing creates property children under it', async () => {
      // Pre-flip this pass is the ONLY writer of property-child rows, which is
      // what makes "the row count stopped moving" mean "converged". Post-flip the
      // live maintainers are on, so every new property key creates its own field
      // and value rows — work the pass never did and has nothing to redo. Counting
      // that as unconverged burned all four sweeps and gave up on a workspace that
      // was already complete, AFTER the flip had landed.
      await create('b1', {'demo:note': 'done'})
      await runPropertyCellBackfill(makeCtx())
      await flip()

      let n = 0
      const progress = await runPropertyCellBackfill(makeCtx(), async () => {
        n += 1
        await create(`live-${n}`, {'demo:note': `written while it ran ${n}`})
      })

      expect(progress.sweeps).toBeLessThan(4)
    })

    it('does not report a run that migrated everything as a total failure', async () => {
      // The systematic-failure banner keys on "nothing was materialized". Per
      // sweep, post-flip, that is ALWAYS true of the converging sweep — it is the
      // one that found nothing pending — while failures keep being counted every
      // sweep. So the first post-flip run of any workspace holding one undecodable
      // cell value reported "Nothing was migrated" over a run that migrated the
      // rest, and suppressed the repair worklist it exists to show.
      await create('b1', {'demo:note': 'migrates fine'})
      await create('b2', {})
      await flip()
      // Raw, so no processor normalizes it — the shape legacy junk has.
      await sharedDb.db.execute(`UPDATE blocks SET properties_json = ? WHERE id = ?`,
        [JSON.stringify({'demo:extra': {not: 'a string'}}), 'b2'])

      const progress = await runPropertyCellBackfill(makeCtx())

      expect(progress.failureCount).toBe(1)
      expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['migrates fine'])
      // The per-sweep count is zero on the converging sweep and that is CORRECT;
      // the run-scoped total is what says whether anything worked.
      expect(progress.valuesMaterializedTotal).toBeGreaterThan(0)
    })

    it('does not tell the operator to re-run because someone typed', async () => {
      // `editedUnderPass` means "the pass rewrote value children from cells that
      // were changing under it". Create-only rewrites nothing, so post-flip it can
      // only mean "someone touched a property" — which the dual-write already
      // handled. The advice it triggers ("run this again") is then a no-op loop,
      // and near-permanently on: editorSelection and isEditing are registered
      // properties, so a caret move is a property write.
      await create('b1', {'demo:note': 'done'})
      await runPropertyCellBackfill(makeCtx())
      await flip()

      let n = 0
      const progress = await runPropertyCellBackfill(makeCtx(), async () => {
        n += 1
        // A PROPERTY write, which is what moves the child rows' timestamp — a
        // content edit would leave the flag clear for the wrong reason.
        await repo.tx(async tx => { await tx.setProperty('b1', noteProp, `typed ${n}`) },
          {scope: ChangeScope.BlockDefault, description: 'live edit'})
      })

      // The dual-write already put that value in the child, so there is nothing
      // for the operator to re-run.
      expect((await fieldRowsOf('b1'))[0]!.values).toEqual([`typed ${n}`])
      expect(progress.editedUnderPass).toBe(false)
    })

    it('does not resurrect a property that was deleted through its children', async () => {
      // "A cell key with no live field row" has TWO causes post-flip: history the
      // pass exists to materialize, and a property DELETED through the children on
      // a peer whose owner row has not caught up here. Treating the second as the
      // first recreates the property AND uploads it, undoing the delete for the
      // whole fleet.
      await create('b1', {'demo:note': 'deleted on a peer'})
      await runPropertyCellBackfill(makeCtx())
      const fieldRow = (await fieldRowsOf('b1'))[0]!
      await flip()
      // Raw, so no processor re-projects the owner cell — the shape a
      // sync-applied delete has while this device still holds the stale bag.
      await sharedDb.db.execute(
        `UPDATE blocks SET deleted = 1 WHERE id = ? OR parent_id = ?`,
        [fieldRow.id, fieldRow.id])

      await runPropertyCellBackfill(makeCtx())

      expect(await fieldRowsOf('b1')).toEqual([])
    })

    it('converges on a workspace holding a key no schema declares', async () => {
      // An unregistered key can never get a field row, so it stays in the pending
      // set for every sweep. If that counts as work, the "materialized nothing"
      // convergence test never succeeds and the run ends in a give-up — on the
      // very graphs audit-properties exists to find, and after the flip landed.
      await create('b1', {'demo:note': 'fine', 'demo:nobody-declares-this': 'x'})
      await flip()

      const progress = await runPropertyCellBackfill(makeCtx())

      expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['fine'])
      expect((await repo.load('b1'))?.properties['demo:nobody-declares-this']).toBe('x')
      expect(progress.sweeps).toBeLessThan(4)
    })

    it('does not sweep an owner whose cell has emptied out', async () => {
      // The orphan leg exists to delete, and only to delete: its owners are
      // the ones whose bag no longer holds anything. Post-flip an empty bag is
      // not a deleted property, it is an unprojected one, and running the leg
      // tombstones every value row on the block.
      await create('b1', {'demo:note': 'kept'})
      await runPropertyCellBackfill(makeCtx())
      await flip()
      await rawCell('b1', {})

      const progress = await runPropertyCellBackfill(makeCtx())

      expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['kept'])
      expect(progress.orphanedOwnersSwept).toBe(0)
    })
  })

  it('lets an operator run again after completion, so a straggler is not stranded', async () => {
    // Everything the pass can miss — a block edited behind the cursor, a
    // legacy value repaired since, a property written between the last sweep
    // and the flip — is only recoverable if the operator can ask again. A
    // recorded completion stops the UNATTENDED path; it must not stop a human.
    await create('b1', {'demo:note': 'first'})
    expect((await run()).outcome).toBe('ran')

    await create('b2', {'demo:note': 'later'})
    expect((await run()).outcome).toBe('ran')

    expect((await fieldRowsOf('b2'))[0]!.values).toEqual(['later'])
  })

  it('clears the undo history it wrote past, and says so', async () => {
    await create('b1', {'demo:note': 'hello'})
    await repo.tx(async tx => {
      await tx.update('b1', {content: 'user edit'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})

    expect(await run()).toEqual({outcome: 'ran', undoHistoryCleared: true})

    await repo.undo(ChangeScope.BlockDefault)
    expect((await repo.load('b1'))?.content).toBe('user edit')
  })

  it("deletes a removed key's children even when another key on the block is junk", async () => {
    // The materializer walks the name list and THROWS at the first undecodable
    // cell value, so catching per ROW strands every name after it — and the
    // deletion names come last. One junk value kept the children of a key the
    // user had deleted, which the flip would then make authoritative.
    await create('b1', {'demo:note': 'gone soon'})
    await runPropertyCellBackfill(makeCtx())
    expect(await fieldRowsOf('b1')).toHaveLength(1)

    // Raw, so no processor normalizes it on the way in — the shape legacy
    // junk and a sync-applied row both have.
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = ? WHERE id = ?`,
      [JSON.stringify({'demo:extra': {not: 'a string'}}), 'b1'],
    )

    const progress = await runPropertyCellBackfill(makeCtx())

    expect(await fieldRowsOf('b1')).toEqual([])
    // Two sweeps ran and the junk key failed in each, but the operator's
    // repair worklist names it once: counts are the CURRENT sweep's.
    expect(progress.sweeps).toBe(2)
    expect(progress.failureCount).toBe(1)
    expect(progress.failures).toHaveLength(1)
  })

  it('removes the children of a block whose LAST property was deleted', async () => {
    // The candidate scan selects on a NON-EMPTY bag, so an owner that loses
    // its final property drops out of it entirely — and the deletion path,
    // which only runs for owners the scan visits, could never reach it. Its
    // field row survived every re-run, and the flip would make it
    // authoritative, resurrecting the property.
    await create('b1', {'demo:note': 'gone soon'})
    await runPropertyCellBackfill(makeCtx())
    expect(await fieldRowsOf('b1')).toHaveLength(1)

    await repo.tx(async tx => {
      await tx.update('b1', {properties: {}})
    }, {scope: ChangeScope.BlockDefault, description: 'user deletes the last property'})

    const progress = await runPropertyCellBackfill(makeCtx())

    expect(await fieldRowsOf('b1')).toEqual([])
    // A run total, not the converging sweep's: the sweep that deletes is never
    // the one that converges, so a per-sweep count reports zero for a run whose
    // only effect was removing children.
    expect(progress.orphanedOwnersSwept).toBe(1)
  })

  it('converges while a property is rewritten under it, as an open editor does', async () => {
    // `editorSelection` and `isEditing` are registered properties on the panel
    // block, so a caret movement IS a property write. Treating a rewritten
    // value child as "not converged yet" bought a full extra sweep for each
    // one, and four of them ended the run unconverged with every row already
    // written and no completion recorded.
    const ids = await seedNotes(TWO_BATCHES)

    let caret = 0
    const reported: boolean[] = []
    const progress = await runPropertyCellBackfill(makeCtx(), async p => {
      reported.push(p.editedUnderPass)
      caret += 1
      await repo.tx(async tx => {
        await tx.update(ids[0]!, {properties: {'demo:note': `caret-${caret}`}})
      }, {scope: ChangeScope.BlockDefault, description: 'caret move'})
    })

    expect(progress.sweeps).toBe(2)
    // Subscribers learn everything through onProgress, which otherwise fires
    // only from inside a batch — so without a final notification the palette
    // saw every count except the one thing it has to act on.
    expect(reported.at(-1)).toBe(true)
    // Converging is not the same as being caught up: the sweep that converged
    // was still rewriting value children, so the operator is told to run again
    // rather than left to assume the children match the cells.
    expect(progress.editedUnderPass).toBe(true)
  })

  it('will not follow a field row into another workspace to delete its owner', async () => {
    // The orphan leg reaches an owner through its FIELD ROWS, and `tx.get`
    // selects on id alone — nothing downstream re-checks the workspace. The
    // parent link is not proof of one either: sync arrivals write `blocks`
    // without the tx layer's parent check, so one bad `parent_id` from the
    // server is all it takes to point a local field row at a foreign block.
    await create('b1', {'demo:note': 'mine'})
    await runPropertyCellBackfill(makeCtx())
    const fieldRow = (await repo.db.getAll<{id: string}>(
      `SELECT id FROM blocks WHERE parent_id = ? AND is_field_form = 1`, ['b1'],
    ))[0]!.id
    // The owner is now foreign; its field row still looks local. Raw, because
    // this is the shape a sync-applied row has and no processor produces it.
    await sharedDb.db.execute(
      `UPDATE blocks SET workspace_id = ?, properties_json = '{}' WHERE id = ?`,
      ['other-ws', 'b1'],
    )

    await runPropertyCellBackfill(makeCtx())

    expect((await repo.db.get<{n: number}>(
      `SELECT COUNT(*) AS n FROM blocks WHERE id = ? AND deleted = 0`, [fieldRow],
    ))!.n).toBe(1)
  })

  it('migrates a block carrying more keys than one transaction budgets for', async () => {
    // The budget is in inserted ROWS, so a block heavy enough to blow it on
    // its own must still be taken — a batch that admits nothing never drains
    // the queue.
    const many = Array.from({length: 120}, (_, i) => seedProperty({
      seedKey: `test/property/bulk-${i}`, revision: 1, name: `demo:bulk${i}`,
      preset: 'optional-string', defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
    }))
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      ...many.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
    ], {repo, workspaceId: WS, safeMode: false}))
    await create('fat', Object.fromEntries(many.map(prop => [prop.name, 'v'])))

    const progress = await runPropertyCellBackfill(makeCtx())

    expect(await fieldRowsOf('fat')).toHaveLength(many.length)
    expect(progress.failureCount).toBe(0)
  })

  it('scans candidates through the non-empty properties index', async () => {
    // The index is only reachable because the predicate carries the literal
    // `properties_json <> '{}'`; SQLite cannot infer it from the json_each
    // EXISTS. Drop either half and every batch re-reads and re-sorts the whole
    // workspace instead.
    const plan = await repo.db.getAll<{detail: string}>(
      `EXPLAIN QUERY PLAN ${CANDIDATE_SQL}`, [WS, '', 10],
    )

    expect(plan.map(row => row.detail).join(' | '))
      .toContain('idx_blocks_workspace_nonempty_properties')
  })

  it('is never scheduled — only an operator can start it', async () => {
    await create('b1', {'demo:note': 'hello'})

    repo.scheduleWorkspaceBackfills(WS)
    await repo.awaitWorkspaceBackfills()

    expect(await fieldRowCount()).toBe(0)
  })
})
