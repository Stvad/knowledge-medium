// @vitest-environment node
/**
 * Fuzz suite for `convertEmptyChildBlockToProperty`
 * (`src/utils/propertyCreation.ts`) — the `>`-on-empty-block gesture that
 * `delete()`s a scaffold block and turns it into a property-create request
 * on its parent. Two independent holes were already found and fixed in
 * this one small guard:
 *  - 6956dfc63: guarded only the VISIBLE `childIds` facade
 *    (`hidePropertyChildren: true`), so a block whose only content was
 *    HIDDEN property field/value rows read as empty and got deleted,
 *    stranding that data. Fixed by also checking the cell
 *    (`data.properties`).
 *  - b0392a7c9: the cell can ALSO be empty while hidden field/value rows
 *    are still live (a forced find-replace / broken value-row edit makes
 *    PROJECT drop the cell key while the rows stay live) — so cell-only
 *    was still not enough. Fixed by loading the STRUCTURAL child list
 *    (`hidePropertyChildren: false`) instead of the visible facade.
 *
 * `src/utils/test/propertyCreation.test.ts` pins one fixed example per
 * fix. This suite sweeps the full lattice the guard's own two checks
 * define (propertyCreation.ts:29-35):
 *   convert  ⟺  structural childIds EMPTY  ∧  cell (`data.properties`) EMPTY
 * across {cell state} × {structural-child-row state} × {workspace flip
 * state} — the flip axis matters because it's what makes the diverged
 * "empty cell, live hidden rows" state naturally reachable in practice,
 * but the guard's OWN check (`hidePropertyChildren: false`) is flip-
 * independent by construction, so the property must hold in BOTH flip
 * states for every cell/structural combination, not just the flipped one.
 *
 * Oracle: `converted === (cellEmpty && structuralEmpty)`, and:
 *  - when converted: the parent gets `showPropertiesProp` + a pending
 *    property-create request, and the child is soft-deleted;
 *  - when refused: the child survives live, the parent is untouched, and
 *    every structural row planted for the case survives live (nothing
 *    stranded/soft-deleted by a conversion that should not have happened).
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { showPropertiesProp } from '@/data/properties'
import { consumePendingPropertyCreateRequest } from '@/utils/propertyNavigation'
import { convertEmptyChildBlockToProperty } from '@/utils/propertyCreation'

type CellState = 'empty' | 'orphanKey'
type StructState = 'empty' | 'contentChild' | 'handAuthoredFieldRow'
type Flip = 'cell' | 'children'

const CELL_STATES: readonly CellState[] = ['empty', 'orphanKey']
const STRUCT_STATES: readonly StructState[] = ['empty', 'contentChild', 'handAuthoredFieldRow']
const FLIPS: readonly Flip[] = ['cell', 'children']

const FIELD_ID = 'hand-authored-field-def'

const caseArb = fc.record({
  cellState: fc.constantFrom(...CELL_STATES),
  structState: fc.constantFrom(...STRUCT_STATES),
  flip: fc.constantFrom(...FLIPS),
  noise: fc.string({minLength: 1, maxLength: 12}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})
afterEach(() => { consumePendingPropertyCreateRequest('parent') })
const guard = statefulFuzzGuard()

const runCase = async (
  {cellState, structState, flip, noise}:
  {cellState: CellState; structState: StructState; flip: Flip; noise: string},
): Promise<void> => {
  await resetTestDb(sharedDb.db)
  consumePendingPropertyCreateRequest('parent') // defensive: clear any leak from an abandoned prior case
  if (flip === 'children') {
    await sharedDb.db.execute(
      `INSERT OR REPLACE INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES ('ws-1', 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
    )
  }
  const repo = createTestRepo({
    db: sharedDb.db, user: {id: 'user-1'}, newId: () => crypto.randomUUID(), startSyncObserver: false,
  }).repo

  await repo.tx(async tx => {
    await tx.create({id: 'parent', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Parent'})
    await tx.create({id: 'child', workspaceId: 'ws-1', parentId: 'parent', orderKey: 'a0'})
  }, {scope: ChangeScope.BlockDefault, description: 'fixture'})

  // ── cell dimension: an ORPHAN key (no registered schema anywhere in this
  //    suite) never grows structural children on its own — keeps the two
  //    dimensions independent regardless of flip state. ──
  if (cellState === 'orphanKey') {
    await repo.tx(tx => tx.update('child', {properties: {'unregistered-note': noise}}),
      {scope: ChangeScope.BlockDefault})
  }

  // ── structural dimension, independent of the cell ──
  if (structState === 'contentChild') {
    await repo.tx(async tx => {
      await tx.create({id: 'sibling-content', workspaceId: 'ws-1', parentId: 'child', orderKey: 'a0', content: noise})
    }, {scope: ChangeScope.BlockDefault})
  } else if (structState === 'handAuthoredFieldRow') {
    // A `::((fieldId))` field row + value child, hand-authored directly —
    // simulates the b0392a7c9 diverged state (live rows, empty cell)
    // without needing to reproduce the exact PROJECT-drop mechanism: the
    // guard's structural-list check doesn't care how the rows got there.
    //
    // FIELD_ID must be a REGISTERED property-schema definition: the
    // VISIBLE-children predicate only excludes a field row when its
    // `reference_target_id` resolves to a live `block_types`
    // 'property-schema' entry (`recognizedFieldRowSql`,
    // treeQueries.ts:285-299). An unregistered FIELD_ID leaves `hand-field`
    // visible like any ordinary content child, degenerating this axis into
    // the `contentChild` case and leaving the b0392a7c9 regression (hidden
    // rows, empty cell) untested — the pre-fix guard would pass this case
    // too, since it never sees a divergence between the visible and
    // structural lists (Codex review, comment 3672657052).
    await repo.tx(async tx => {
      await tx.create({
        id: FIELD_ID, workspaceId: 'ws-1', parentId: null, orderKey: 'a1',
        content: 'field def', properties: {types: ['property-schema']},
      })
      await tx.create({
        id: 'hand-field', workspaceId: 'ws-1', parentId: 'child',
        referenceTargetId: FIELD_ID, isFieldForm: true, orderKey: 'a0', content: `::((${FIELD_ID}))`,
      })
      await tx.create({
        id: 'hand-value', workspaceId: 'ws-1', parentId: 'hand-field', orderKey: 'a0', content: noise,
      })
    }, {scope: ChangeScope.BlockDefault})
  }

  // Non-vacuity check for the `handAuthoredFieldRow` axis: in a flipped
  // workspace, the row registered above must actually be hidden from the
  // VISIBLE facade before conversion runs — otherwise the case below isn't
  // exercising the diverged state (structural rows live, visible list AND
  // cell both empty) at all. `flip === 'cell'` workspaces recognize no
  // field rows by design (VISIBLE_CHILD_PREDICATE_SQL short-circuits on the
  // un-flipped probe), so this only applies once flipped.
  if (structState === 'handAuthoredFieldRow' && flip === 'children') {
    const visibleIds = await repo.query.childIds({id: 'child', hidePropertyChildren: true}).load()
    expect(visibleIds, 'hand-authored field row must be hidden from the visible facade').toEqual([])
  }

  const converted = await convertEmptyChildBlockToProperty(repo.block('child'), repo)
  const expectConverted = cellState === 'empty' && structState === 'empty'
  expect(converted, `cellState=${cellState} structState=${structState} flip=${flip}`).toBe(expectConverted)

  if (expectConverted) {
    expect(repo.block('parent').peekProperty(showPropertiesProp)).toBe(true)
    expect(consumePendingPropertyCreateRequest('parent')).toMatchObject({blockId: 'parent'})
    expect(repo.block('child').peek()).toBeNull()
    expect(repo.block('child').peekRaw()?.deleted).toBe(true)
    return
  }

  // Refused: nothing about the case's planted state may be stranded.
  expect(repo.block('child').peek()?.deleted).toBe(false)
  expect(repo.block('parent').peekProperty(showPropertiesProp)).toBeUndefined()
  if (structState === 'contentChild') {
    expect(repo.block('sibling-content').peek()?.deleted).toBe(false)
  } else if (structState === 'handAuthoredFieldRow') {
    expect(repo.block('hand-field').peek()?.deleted).toBe(false)
    expect(repo.block('hand-value').peek()?.deleted).toBe(false)
  }
}

describe('convertEmptyChildBlockToProperty: lattice sweep', () => {
  it('converts iff BOTH the cell and the structural child list are empty, in every flip state', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({cellState, structState, flip, noise, prngSeed}) =>
        guard.run(prngSeed, () => runCase({cellState, structState, flip, noise}))),
      fuzzParams(30),
    )
  }, fuzzTestTimeout())
})
