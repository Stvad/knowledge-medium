// @vitest-environment node
/**
 * Fuzz suite for the properties-as-blocks §5 processor pair
 * (`src/data/internals/propertyChildrenProcessor.ts`):
 * `core.materializePropertyChildren` (cell → children) and
 * `core.projectPropertyChildren` (children → cell). That file's own
 * docblock (:22-42) states the load-bearing contract this suite pins:
 *   1. IDEMPOTENCE — every write there is skipped when output already
 *      equals input, so a round trip through both processors is a no-op.
 *   2. the pair converges rather than ping-pongs.
 * See docs/fuzzing.md for tier mechanics; `src/data/propertyChildren.test.ts`
 * pins one fixed example of the same-tx idempotence shape this suite
 * generalizes (:209-226, "the same-tx projection is idempotent").
 *
 * Oracles:
 *  - cell → children → cell round trip: a raw `tx.update({properties})`
 *    write drives `materializePropertyChildrenForExistingRow` (:329-450) to
 *    create/update the field+value children FROM the cell, and
 *    `core.projectPropertyChildren` re-runs in the SAME tx
 *    (`rerunOnDirtyRows`, :584) to re-derive the cell FROM those children —
 *    the round trip must reproduce exactly the value written.
 *  - MATERIALIZE re-run is a no-op: calling the exported convergence
 *    primitive `materializePropertyChildrenForExistingRow` again on an
 *    already-converged row (same names) writes NOTHING — the
 *    `primary.content !== content` / `primaryValue.content !== content`
 *    guards (:400-409) skip when nothing changed. Verified via row_events
 *    for exactly the field/value rows: zero from the re-run.
 *  - PROJECT re-run is a no-op: calling the exported
 *    `reprojectOwnersForRowStates` again with the SAME row state writes
 *    NOTHING to the parent — the `propertiesEqual` short-circuit (:276).
 *    Verified via the parent's row_events.
 *  - Engine-level repeat: writing the IDENTICAL cell bag a second time
 *    through `tx.update` is a true no-op end-to-end —
 *    `updatePatchChangesBlock` (txEngine.ts:569) short-circuits before
 *    either processor runs — zero row_events anywhere.
 *
 * Both exported primitives are fed HAND-BUILT lookups matching the
 * (unexported) `PropertyChildrenLookups` shape — this suite deliberately
 * stays at the same public boundary the slice-C backfill uses
 * (`materializePropertyChildrenForExistingRow`'s own docblock: "Exported
 * for slice C's one-time backfill"), not the internal ctx-resolver seam.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import type { Repo } from '@/data/repo'
import {
  materializePropertyChildrenForExistingRow,
  reprojectOwnersForRowStates,
  type ProjectableRow,
} from './propertyChildrenProcessor'

const WS = 'ws-pcp-fuzz'

const statusSchema = defineProperty<string>('status', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const countSchema = defineProperty<number>('count', {
  codec: codecs.number, defaultValue: 0, changeScope: ChangeScope.BlockDefault,
})
const flagSchema = defineProperty<boolean>('flag', {
  codec: codecs.boolean, defaultValue: false, changeScope: ChangeScope.BlockDefault,
})
const relatedSchema = defineProperty<string>('related', {
  codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault,
})

type Kind = 'status' | 'count' | 'flag' | 'related'
const SCHEMAS: Record<Kind, {schema: AnyPropertySchema; fieldId: string}> = {
  status: {schema: statusSchema, fieldId: 'field-status'},
  count: {schema: countSchema, fieldId: 'field-count'},
  flag: {schema: flagSchema, fieldId: 'field-flag'},
  related: {schema: relatedSchema, fieldId: 'field-related'},
}

/** Hand-built to match the shape `materializePropertyChildrenForExistingRow`
 *  / `reprojectOwnersForRowStates` expect (the (unexported)
 *  `PropertyChildrenLookups` / exported `ProjectionLookups` types) —
 *  structural, no import of the private type needed. */
interface Lookups {
  resolveFieldSchema: (fieldId: string) => AnyPropertySchema | undefined
  resolveNameSchema: (name: string) => (AnyPropertySchema & {fieldId: string}) | undefined
}
const lookups: Lookups = {
  resolveFieldSchema: fieldId => Object.values(SCHEMAS).find(e => e.fieldId === fieldId)?.schema,
  resolveNameSchema: name => {
    const entry = Object.values(SCHEMAS).find(e => e.schema.name === name)
    return entry ? {...entry.schema, fieldId: entry.fieldId} : undefined
  },
}

// Block-ref-safe, non-UUID-shaped id alphabet — see the identical arb in
// propertyChildren.fuzz.test.ts for why (referenceBlock.ts:23, :111-127).
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
const idArb = fc.array(fc.constantFrom(...ID_ALPHABET), {minLength: 1, maxLength: 16})
  .map(cs => cs.join(''))
const finiteArb = fc.double({noNaN: true, noDefaultInfinity: true}).filter(n => !Object.is(n, -0))

const valueArbFor = (kind: Kind): fc.Arbitrary<unknown> => {
  switch (kind) {
    case 'status': return fc.string({maxLength: 20})
    case 'count': return finiteArb
    case 'flag': return fc.boolean()
    case 'related': return idArb
  }
}

const KIND_ARB: fc.Arbitrary<Kind> = fc.constantFrom('status', 'count', 'flag', 'related')
const caseArb = KIND_ARB.chain(kind => fc.record({
  kind: fc.constant(kind),
  // 1-3 sequential writes to the SAME key: length 1 exercises MATERIALIZE's
  // create branch, length >1 its update-existing-row branch too.
  values: fc.array(valueArbFor(kind), {minLength: 1, maxLength: 3}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
}))

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})
/** Interrupt-barrier + Math.random pin — MATERIALIZE's child creates use
 *  jittered order keys (`keyAtStart`, docs/fuzzing.md §6). */
const guard = statefulFuzzGuard()

const seedWorkspace = async (): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
    [WS, 'ws', 'user-1'],
  )
}

const setup = (): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  for (const {schema, fieldId} of Object.values(SCHEMAS)) {
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      `test-${schema.name}-definition`,
      [{
        metadata: {
          fieldId, workspaceId: WS, createdAt: 1, name: schema.name,
          changeScope: schema.changeScope, hidden: false, origin: 'user' as const,
        },
        schema,
      }],
      {workspaceId: WS},
    )
  }
  return repo
}

const cellValue = async (id: string): Promise<Record<string, unknown>> => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id])
  return JSON.parse(row.properties_json) as Record<string, unknown>
}

interface ChildRow {
  id: string; content: string; deleted: number
  is_field_form: number | null; reference_target_id: string | null
}
const childrenRows = async (parentId: string): Promise<ChildRow[]> =>
  sharedDb.db.getAll<ChildRow>(
    `SELECT id, content, deleted, is_field_form, reference_target_id
       FROM blocks WHERE parent_id = ? ORDER BY order_key, id`,
    [parentId],
  )

const updateEventCount = async (blockId: string): Promise<number> =>
  (await sharedDb.db.getAll<{id: number}>(
    `SELECT id FROM row_events WHERE block_id = ? AND kind = 'update'`, [blockId],
  )).length

const runCase = async ({kind, values}: {kind: Kind; values: unknown[]}): Promise<void> => {
  await resetTestDb(sharedDb.db)
  await seedWorkspace()
  const repo = setup()
  await repo.tx(async tx => {
    await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
  }, {scope: ChangeScope.BlockDefault})

  const {schema, fieldId} = SCHEMAS[kind]

  for (const v of values) {
    await repo.tx(tx => tx.update('p', {properties: {[schema.name]: v}}),
      {scope: ChangeScope.BlockDefault})
    // cell → children → cell: the same tx's MATERIALIZE then PROJECT
    // (rerunOnDirtyRows) must reproduce exactly what was just written.
    expect(await cellValue('p'), `after writing ${JSON.stringify(v)}`).toEqual({[schema.name]: v})
  }
  const lastValue = values.at(-1)

  const fieldRows = (await childrenRows('p'))
    .filter(r => r.deleted === 0 && r.reference_target_id === fieldId)
  expect(fieldRows).toHaveLength(1)
  const fieldRowId = fieldRows[0]!.id
  const converged = await childrenRows(fieldRowId)
  expect(converged, 'exactly one live primary value child in a converged row').toHaveLength(1)
  const valueRowId = converged[0]!.id

  // ── MATERIALIZE re-run: an already-converged row is untouched ──
  // The docblock's contract above (:22-27) is LITERAL — "writes NOTHING",
  // not just "no observable diff": the `primary.content !== fieldContent` /
  // `primaryValue.content !== content` guards
  // (propertyChildrenProcessor.ts:400-409) skip the `tx.update` call
  // entirely when nothing changed, so a converged re-run must emit zero
  // row_events for EITHER row. `childrenRows` below only compares SELECTED
  // structural columns (content/deleted/is_field_form/reference_target_id)
  // — a regression that rewrites the field or value row WITHOUT changing
  // those (e.g. one of the two guards above dropped, so the call goes
  // through unconditionally) would pass it silently UNLESS the write also
  // happens to be a true no-op the engine's own generic
  // `updatePatchChangesBlock` short-circuit (txEngine.ts:106) catches first
  // — this assertion doesn't assume that second layer holds, since a
  // regression could just as easily swap in a write primitive that isn't
  // gated by it. The event baselines further down are no substitute
  // either way: they're captured AFTER this call, so a leak here is
  // invisible to them. Snapshot both rows' update-event counts BEFORE the
  // call instead (Codex review, comment 3676658264).
  const beforeMaterialize = {
    field: await updateEventCount(fieldRowId),
    value: await updateEventCount(valueRowId),
  }
  await repo.tx(async tx => {
    const row = await tx.get('p')
    await materializePropertyChildrenForExistingRow(tx, row!, lookups, [schema.name])
  }, {scope: ChangeScope.BlockDefault})
  expect(await updateEventCount(fieldRowId), 'MATERIALIZE re-run: field row gets no write')
    .toBe(beforeMaterialize.field)
  expect(await updateEventCount(valueRowId), 'MATERIALIZE re-run: value row gets no write')
    .toBe(beforeMaterialize.value)
  expect(await childrenRows(fieldRowId)).toEqual(converged)
  expect(await cellValue('p')).toEqual({[schema.name]: lastValue})

  // ── PROJECT re-run: an already-correct cell is untouched ──
  const parentUpdatesBeforeProject = await updateEventCount('p')
  await repo.tx(async tx => {
    const fieldRowState: ProjectableRow = {
      id: fieldRowId, parentId: 'p', workspaceId: WS,
      referenceTargetId: fieldId, isFieldForm: true,
    }
    await reprojectOwnersForRowStates(tx, [fieldRowState], lookups, 'full')
  }, {scope: ChangeScope.BlockDefault})
  expect(await updateEventCount('p')).toBe(parentUpdatesBeforeProject)
  expect(await cellValue('p')).toEqual({[schema.name]: lastValue})

  // ── Engine-level repeat: the identical raw cell write again is inert ──
  const before = {parent: await updateEventCount('p'), field: await updateEventCount(fieldRowId)}
  await repo.tx(tx => tx.update('p', {properties: {[schema.name]: lastValue}}),
    {scope: ChangeScope.BlockDefault})
  expect(await updateEventCount('p')).toBe(before.parent)
  expect(await updateEventCount(fieldRowId)).toBe(before.field)
}

describe('MATERIALIZE / PROJECT: convergent idempotent pair', () => {
  it('cell → children → cell round-trips; re-running either processor, or repeating the write, is a no-op', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({kind, values, prngSeed}) =>
        guard.run(prngSeed, () => runCase({kind, values}))),
      fuzzParams(20),
    )
  }, fuzzTestTimeout())
})
