// @vitest-environment node
/**
 * Fuzz: N-way property-definition RENAMES through `core.migratePropertyDefinition`
 * (`internals/propertyDefinitionChangeProcessor.ts`) — swaps, longer cycles,
 * renames onto fresh names and onto the name a tombstoned definition used to
 * hold, mixed with deleting and reviving definitions in the same batch. A rename
 * re-keys every consuming parent's cell in the tx that edits the definition, so
 * a permutation bug is silent data corruption across the whole workspace.
 *
 * Each case builds a `'children'` workspace: live user definitions on mixed
 * presets, tombstoned definitions whose consumers outlive them, plain, nested
 * and definition-block hosts, values written through `setProperty`, a raw cell
 * write (MATERIALIZE builds the children) and hand-built field rows (PROJECT
 * builds the cell), cell-only keys with no field row, sync-shaped duplicate
 * field rows and a tombstoned consumer. One batch of ops is then delivered as
 * ONE tx, split across consecutive txs, or (sync) as the initiator's finished
 * rows arriving through `blocks_synced` at a device holding the pre-state.
 *
 * Oracles:
 *  - refusal model: a tx is refused as `contested` iff a renamed definition
 *    with a live field row anywhere ends up sharing its new name with another
 *    definition or a seed, or vacates a name a definition outside the batch
 *    holds after commit; failing that, as `shared-name` iff a renamed or
 *    revived definition ends up sharing a name with any definition that has
 *    consumers. A refused tx changes no row;
 *  - conservation: an accepted tx creates and tombstones nothing, rewrites
 *    only the definition rows it edits (plus each one's own name value child)
 *    and consumers' `properties`; on a consumer every renamed definition's old
 *    key is gone, its new key holds the projection of its field rows, and every
 *    other key is untouched;
 *  - value model: after every step, every value written under a never-deleted
 *    definition sits under that definition's current name;
 *  - name ownership: every live definition with consumers is the only
 *    claimant of its name in the rebuilt registry;
 *  - undo of the accepted tx(s) restores the exact pre-state and redo the
 *    exact post-state (timestamps aside: a replay is a fresh write);
 *  - reference model: the same accepted ops applied one definition at a time
 *    through temporary names reach the same state;
 *  - re-running the processor over the same changed definition rows writes
 *    nothing;
 *  - sync: the receiving device ends in the initiator's state and leaves it
 *    there.
 *
 * Out of scope: re-types (codec changes), and ref-typed presets, whose
 * reference projection belongs to the references plugin.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import {
  ChangeScope,
  defineProperty,
  defineSameTxProcessor,
  ProcessorRejection,
  PropertySchemaIdentityError,
  type AnyPropertySchema,
  type ChangedRow,
} from '@/data/api'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams, parseBlockRow, type BlockRow } from '@/data/blockSchema'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { sameTxProcessorsFacet } from '@/data/facets'
import { kernelValuePresetCoresById } from '@/data/kernelValuePresetCores'
import { keyAtEnd, keysBetween } from '@/data/orderKey'
import {
  childContentsToEncodedPropertyValue,
  encodedPropertyValueToChildContents,
  propertyFieldContent,
  unionValuesAcrossFieldRows,
} from '@/data/propertyChildren'
import { propertyDefinitionClaimantsForName } from '@/data/propertyDefinitionRegistry'
import { jsonValuesEqual } from '@/data/internals/jsonCanonical'
import { presetIdProp, propertyChangeScopeProp, propertyNameProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { MIGRATE_PROPERTY_DEFINITION_PROCESSOR } from '@/data/internals/propertyDefinitionChangeProcessor'
import type { Repo } from '@/data/repo'

const WS = 'ws-def-rename-fuzz'
const SCOPE = {scope: ChangeScope.BlockDefault} as const
const CONTESTED = 'property.definition-change.contested'
const SHARED_NAME = 'property.definition-change.shared-name'

const PRESETS = ['string', 'number', 'boolean', 'string-list'] as const
type Preset = typeof PRESETS[number]
const NAME_POOL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'] as const
/** A kernel seed's name: a rename onto it must be refused like any other
 *  claimed name, though no row for it has materialized. */
const SEED_NAME = 'types'

/** Projection-only schemas over each preset's own codec: what a field row's
 *  children project to depends on the codec alone. */
const projectionSchemas: Record<Preset, AnyPropertySchema> = {
  string: defineProperty('projection-string', {
    codec: kernelValuePresetCoresById.string.build(), defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  }),
  number: defineProperty('projection-number', {
    codec: kernelValuePresetCoresById.number.build(), defaultValue: 0,
    changeScope: ChangeScope.BlockDefault,
  }),
  boolean: defineProperty('projection-boolean', {
    codec: kernelValuePresetCoresById.boolean.build(), defaultValue: false,
    changeScope: ChangeScope.BlockDefault,
  }),
  'string-list': defineProperty('projection-string-list', {
    codec: kernelValuePresetCoresById['string-list'].build(), defaultValue: [],
    changeScope: ChangeScope.BlockDefault,
  }),
}

// ── Generated case shape ─────────────────────────────────────────────────────

type Route = 'setProperty' | 'cellWrite' | 'fieldRow'
type ExtraOpKind =
  | 'renameFresh' | 'renameTaken' | 'renameTomb' | 'renameSeed' | 'delete' | 'revive'

interface CaseSpec {
  defs: Array<{nameIdx: number; preset: Preset}>
  /** `sameAsLive`: the name a live definition takes after this one dies —
   *  where a revival collides with, or strands, that definition's values. */
  tombs: Array<{nameIdx: number; preset: Preset; sameAsLive: boolean}>
  hostCount: number
  hostParents: number[]
  deleteLastHost: boolean
  assigns: Array<{host: number; def: number; route: Route; variant: number}>
  cellOnly: Array<{host: number; def: number}>
  dups: Array<{host: number; def: number}>
  /** A permutation of the live definitions' names: who takes part (at least
   *  two always do), and how far the cycle turns. */
  perm: {members: boolean[]; shift: number} | null
  extra: Array<{target: number; kind: ExtraOpKind; dest: number}>
  order: number[]
  delivery: 'single' | 'split' | 'sync'
  cuts: number[]
  syncOrder: 'together' | 'defsFirst' | 'consumersFirst'
  prngSeed: number
}

const presetArb = fc.constantFrom(...PRESETS)
const caseArb: fc.Arbitrary<CaseSpec> = fc.record({
  defs: fc.uniqueArray(
    fc.record({nameIdx: fc.nat({max: NAME_POOL.length - 1}), preset: presetArb}),
    {minLength: 2, maxLength: 5, selector: d => d.nameIdx},
  ),
  tombs: fc.array(
    fc.record({nameIdx: fc.nat({max: NAME_POOL.length - 1}), preset: presetArb, sameAsLive: fc.boolean()}),
    {maxLength: 2},
  ),
  hostCount: fc.integer({min: 1, max: 4}),
  hostParents: fc.array(fc.nat(), {minLength: 4, maxLength: 4}),
  deleteLastHost: fc.boolean(),
  assigns: fc.array(fc.record({
    host: fc.nat(), def: fc.nat(),
    route: fc.constantFrom<Route>('setProperty', 'cellWrite', 'fieldRow'),
    variant: fc.nat({max: 3}),
  }), {minLength: 1, maxLength: 14}),
  cellOnly: fc.array(fc.record({host: fc.nat(), def: fc.nat()}), {maxLength: 2}),
  dups: fc.array(fc.record({host: fc.nat(), def: fc.nat()}), {maxLength: 2}),
  perm: fc.option(fc.record({
    members: fc.array(fc.boolean(), {minLength: 5, maxLength: 5}),
    shift: fc.nat(),
  }), {freq: 5}),
  extra: fc.array(fc.record({
    target: fc.nat(),
    kind: fc.constantFrom<ExtraOpKind>(
      'renameFresh', 'renameFresh', 'renameTaken', 'renameTomb', 'renameSeed', 'delete', 'revive'),
    dest: fc.nat(),
  }), {maxLength: 4}),
  order: fc.array(fc.nat(), {minLength: 8, maxLength: 8}),
  delivery: fc.constantFrom<CaseSpec['delivery']>('single', 'single', 'split', 'sync'),
  cuts: fc.array(fc.nat(), {minLength: 1, maxLength: 2}),
  syncOrder: fc.constantFrom<CaseSpec['syncOrder']>('together', 'defsFirst', 'consumersFirst'),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

// ── Row snapshots ────────────────────────────────────────────────────────────

type Row = BlockRow & Record<string, unknown>
type Snapshot = Map<string, Row>

const TIMESTAMPS = ['updated_at', 'user_updated_at'] as const
/** A synced row carries the REMOTE writer's stamps and attribution. */
const SYNC_STAMPED = [...TIMESTAMPS, 'updated_by'] as const

let sharedDb: TestDb
/** Interrupt barrier + `Math.random` pin: order keys are jittered. */
const guard = statefulFuzzGuard()
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})

const snapshot = async (): Promise<Snapshot> => {
  const rows = await sharedDb.db.getAll<Row>('SELECT * FROM blocks ORDER BY id')
  return new Map(rows.map(row => [row.id, row]))
}

const rowView = (row: Row, omit: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (omit.includes(key)) continue
    out[key] = key === 'properties_json' || key === 'references_json'
      ? JSON.parse(value as string)
      : value
  }
  return out
}

const expectSameRows = (
  actual: Snapshot, expected: Snapshot, omit: readonly string[], label: string,
  skip: ReadonlySet<string> = new Set(),
): void => {
  const ids = (snap: Snapshot) => [...snap.keys()].filter(id => !skip.has(id)).sort()
  expect(ids(actual), `${label}: row set`).toEqual(ids(expected))
  for (const id of ids(expected)) {
    expect(rowView(actual.get(id)!, omit), `${label}: row ${id}`)
      .toEqual(rowView(expected.get(id)!, omit))
  }
}

const cellOf = (snap: Snapshot, id: string): Record<string, unknown> =>
  JSON.parse(snap.get(id)!.properties_json) as Record<string, unknown>

const liveChildren = (snap: Snapshot, parentId: string): Row[] =>
  [...snap.values()]
    .filter(row => row.parent_id === parentId && row.deleted === 0)
    .sort((a, b) => a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const fieldRowsFor = (snap: Snapshot, parentId: string, fieldId: string): Row[] =>
  liveChildren(snap, parentId)
    .filter(row => row.reference_target_id === fieldId && row.is_field_form === 1)

/** What PROJECT publishes for `fieldId` on `parentId`: the union across its
 *  field rows, read through `preset`'s codec. `absent` = no field row at all. */
const projectionOf = (
  snap: Snapshot, parentId: string, fieldId: string, preset: Preset,
): {absent: true} | {absent: false; value: unknown} => {
  const fieldRows = fieldRowsFor(snap, parentId, fieldId)
  if (fieldRows.length === 0) return {absent: true}
  const schema = projectionSchemas[preset]
  const groups = fieldRows.map(fieldRow => liveChildren(snap, fieldRow.id)
    .filter(value => value.is_field_form !== 1)
    .map(value => ({id: value.id, content: value.content})))
  const contents = unionValuesAcrossFieldRows(schema, groups).map(value => value.content)
  return {absent: false, value: childContentsToEncodedPropertyValue(schema, contents)}
}

// ── Definitions as rows ──────────────────────────────────────────────────────

interface DefState {
  readonly id: string
  readonly name: string
  readonly preset: Preset
  readonly deleted: boolean
}

const defStatesOf = (snap: Snapshot, defIds: readonly string[]): Map<string, DefState> =>
  new Map(defIds.map(id => {
    const row = snap.get(id)!
    const bag = JSON.parse(row.properties_json) as Record<string, unknown>
    return [id, {
      id,
      name: bag[propertyNameProp.name] as string,
      preset: bag[presetIdProp.name] as Preset,
      deleted: row.deleted === 1,
    }]
  }))

/** Parents holding a live field row for `fieldId` — the processor's own
 *  consumer gate (`consumingParentIds`), deleted parents included. */
const hasConsumers = (snap: Snapshot, fieldId: string): boolean =>
  [...snap.values()].some(row =>
    row.reference_target_id === fieldId && row.is_field_form === 1
    && row.deleted === 0 && row.parent_id !== null)

// ── Ops and the model ────────────────────────────────────────────────────────

type Op =
  | {kind: 'rename'; id: string; dest: string}
  | {kind: 'delete'; id: string}
  | {kind: 'revive'; id: string}

interface Prediction {
  /** Renames that change a name: id -> old/new. */
  readonly candidates: ReadonlyMap<string, {oldName: string; newName: string}>
  /** The refusal code the tx must fail with, or null when it commits. */
  readonly refusal: typeof CONTESTED | typeof SHARED_NAME | null
}

/** The refusal rules, stated over the state the tx WOULD commit. A rename is
 *  CONTESTED when anyone else ends up under its new name (a seed included), or
 *  a definition outside the batch ends up under the name it leaves; that
 *  refuses the tx when the rename has consumers. Failing that, a renamed or
 *  revived definition that ends up SHARING a name refuses the tx when any
 *  definition under that name has consumers. */
const predict = (
  ops: readonly Op[], states: ReadonlyMap<string, DefState>, snap: Snapshot,
  seedIdByName: ReadonlyMap<string, string>,
): Prediction => {
  const finalName = new Map<string, string>()
  for (const state of states.values()) if (!state.deleted) finalName.set(state.id, state.name)
  const candidates = new Map<string, {oldName: string; newName: string}>()
  for (const op of ops) {
    const state = states.get(op.id)!
    if (op.kind === 'delete') finalName.delete(op.id)
    else if (op.kind === 'revive') finalName.set(op.id, state.name)
    else {
      finalName.set(op.id, op.dest)
      if (op.dest !== state.name) candidates.set(op.id, {oldName: state.name, newName: op.dest})
    }
  }
  const claimantsOf = (name: string): string[] => [
    ...[...finalName].filter(([, held]) => held === name).map(([id]) => id),
    ...(seedIdByName.has(name) ? [seedIdByName.get(name)!] : []),
  ]
  const contested = [...candidates].filter(([id, {oldName, newName}]) =>
    claimantsOf(newName).some(other => other !== id)
    || claimantsOf(oldName).some(other => other !== id && !candidates.has(other)))
  if (contested.some(([id]) => hasConsumers(snap, id))) return {candidates, refusal: CONTESTED}
  const shared = ops
    .filter(op => op.kind !== 'delete')
    .map(op => claimantsOf(finalName.get(op.id)!))
    .some(claimants => claimants.length > 1 && claimants.some(id => hasConsumers(snap, id)))
  return {candidates, refusal: shared ? SHARED_NAME : null}
}

const applyOps = (repo: Repo, ops: readonly Op[]): Promise<void> =>
  repo.tx(async tx => {
    for (const op of ops) {
      const row = await tx.get(op.id)
      if (op.kind === 'delete') await tx.delete(op.id)
      else {
        if (row!.deleted) await tx.restore(op.id)
        if (op.kind === 'rename') await tx.setProperty(op.id, propertyNameProp, op.dest)
      }
    }
  }, SCOPE)

// ── Harness ──────────────────────────────────────────────────────────────────

/** Re-runs `core.migratePropertyDefinition` over `rerunRows` inside a tx — the
 *  processor's own `apply` against a live `SameTxCtx`. */
const RERUN_EVENT = 'test.rerun-definition-migration'
let rerunRows: ChangedRow[] = []
const rerunProcessor = defineSameTxProcessor({
  name: 'test.rerunDefinitionMigration',
  watches: {kind: 'event', events: [RERUN_EVENT]},
  settledWrites: true,
  apply: (event, ctx) =>
    MIGRATE_PROPERTY_DEFINITION_PROCESSOR.apply({...event, changedRows: rerunRows}, ctx),
})

const SCRATCH = 'scratch'

interface Built {
  readonly repo: Repo
  readonly defIds: readonly string[]
  readonly liveIds: readonly string[]
  readonly tombIds: readonly string[]
  /** `${host}|${def}` -> the value written there, for pairs whose cell the
   *  model can predict exactly. */
  readonly modeled: Map<string, {host: string; def: string; value: unknown}>
  /** Seeds claim their names whether or not a row has materialized. */
  readonly seedIdByName: ReadonlyMap<string, string>
  readonly nameFieldId: string
}

/** Wait until the registry publishes exactly what the definition ROWS say —
 *  the processor judges every tx against the tx-start registry. */
const awaitRegistry = async (repo: Repo, defIds: readonly string[]): Promise<void> => {
  const states = defStatesOf(await snapshot(), defIds)
  await vi.waitFor(() => {
    const registry = repo.propertyDefinitions
    if (!registry) throw new Error('[test] no registry')
    for (const state of states.values()) {
      const published = registry.definitionsByFieldId.get(state.id)
      if (state.deleted) {
        if (published) throw new Error(`[test] ${state.id} still published`)
        continue
      }
      if (published?.name !== state.name) {
        throw new Error(`[test] ${state.id} published as ${published?.name}, row says ${state.name}`)
      }
      const schema = registry.schemasByFieldId.get(state.id)
      if (schema?.codec.type !== projectionSchemas[state.preset].codec.type) {
        throw new Error(`[test] ${state.id} has no ${state.preset} behaviour yet`)
      }
    }
  }, {timeout: 2000, interval: 5})
}

const appendKey = async (parentId: string): Promise<string> => {
  const last = await sharedDb.db.getOptional<{order_key: string}>(
    'SELECT order_key FROM blocks WHERE parent_id = ? ORDER BY order_key DESC, id DESC LIMIT 1',
    [parentId])
  return keysBetween(last?.order_key ?? null, null, 1)[0]!
}

const valueFor = (preset: Preset, tag: string, variant: number, seq: number): unknown => {
  switch (preset) {
    case 'string': return `v:${tag}`
    case 'number': return seq + 0.25
    case 'boolean': return seq % 2 === 0
    case 'string-list':
      return [[], [`${tag}:a`], [`${tag}:a`, `${tag}:b`], [`${tag}:a`, `${tag}:a`]][variant]
  }
}

/** A write to a DEFINITION block's bag republishes that definition, so the
 *  schema instance read just before the tx can be stale by tx start; a stale
 *  write is refused whole, so retrying it is safe. */
const setPropertyOnSettledSchema = async (
  repo: Repo, host: string, name: string, value: unknown,
): Promise<void> => {
  let failure: unknown = null
  await vi.waitFor(async () => {
    try {
      await repo.tx(tx => tx.setProperty(host, repo.propertySchemas.get(name)!, value), SCOPE)
    } catch (error) {
      if (error instanceof PropertySchemaIdentityError) throw error
      failure = error
    }
  }, {timeout: 2000, interval: 5})
  if (failure !== null) throw failure
}

const createDefinition = (repo: Repo, id: string, name: string, preset: Preset): Promise<void> =>
  repo.tx(async tx => {
    await tx.create({
      id, workspaceId: WS, parentId: null, orderKey: keyAtEnd(), content: name,
      properties: {
        types: [PROPERTY_SCHEMA_TYPE],
        [propertyNameProp.name]: name,
        [propertyChangeScopeProp.name]: ChangeScope.BlockDefault,
        [presetIdProp.name]: preset,
      },
    })
  }, SCOPE)

const openRepo = async (spec: CaseSpec): Promise<Repo> => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
    [WS],
  )
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [sameTxProcessorsFacet.of(rerunProcessor, {source: 'test'})],
    startSyncObserver: spec.delivery === 'sync',
  })
  repo.setActiveWorkspaceId(WS)
  return repo
}

/** Every case shares one test, so the per-test release never runs between
 *  them: a case's Repo is released here, or its observer would drain the next
 *  case's `blocks_synced` rows into handles nobody reads. */
const releaseRepo = async (repo: Repo): Promise<void> => {
  await repo.flushSyncObserver().catch(() => {})
  repo.stopSyncObserver()
  repo.setActiveWorkspaceId(null)
  await repo.awaitDeferredWork()
}

const build = async (spec: CaseSpec, repo: Repo): Promise<Built> => {
  const hostIds = Array.from({length: spec.hostCount}, (_, i) => `host-${i}`)
  const hostKeys = keysBetween(null, null, hostIds.length)
  await repo.tx(async tx => {
    await tx.create({id: SCRATCH, workspaceId: WS, parentId: null, orderKey: keyAtEnd(), content: ''})
    for (const [i, id] of hostIds.entries()) {
      // Only an EARLIER host can be a parent, so the last host is never one.
      const pick = spec.hostParents[i]!
      const parentId = i > 0 && pick % 2 === 1 ? hostIds[(pick >> 1) % i]! : null
      await tx.create({id, workspaceId: WS, parentId, orderKey: hostKeys[i]!, content: id})
    }
  }, SCOPE)

  const tombIds = spec.tombs.map((_, i) => `tomb-${i}`)
  const liveIds = spec.defs.map((_, i) => `def-${i}`)
  const defIds = [...liveIds, ...tombIds]
  const presetOf = new Map<string, Preset>([
    ...spec.defs.map((d, i) => [liveIds[i]!, d.preset] as const),
    ...spec.tombs.map((d, i) => [tombIds[i]!, d.preset] as const),
  ])
  const nameOf = new Map<string, string>([
    ...spec.defs.map((d, i) => [liveIds[i]!, NAME_POOL[d.nameIdx]!] as const),
    ...spec.tombs.map((d, i) => [tombIds[i]!, d.sameAsLive
      ? NAME_POOL[spec.defs[d.nameIdx % spec.defs.length]!.nameIdx]!
      : NAME_POOL[d.nameIdx]!] as const),
  ])

  const modeled = new Map<string, {host: string; def: string; value: unknown}>()
  const withFieldRow = new Set<string>()
  let seq = 0
  const assign = async (host: string, def: string, route: Route, variant: number) => {
    const key = `${host}|${def}`
    if (withFieldRow.has(key)) return
    withFieldRow.add(key)
    const preset = presetOf.get(def)!
    const name = nameOf.get(def)!
    const value = valueFor(preset, `${host}/${def}`, variant, ++seq)
    // A scalar with no value child is only expressible as a bare field row.
    const empty = preset !== 'string-list' && variant === 0 && route === 'fieldRow'
    // KNOWN ISSUE (fuzz): a cell write equal to what the cell already holds
    // under this name — left there by a deleted definition — writes nothing,
    // so this definition never gets a field row and the value does not follow
    // it (#1209; seed 1526463238). Not modeled until that is fixed.
    const inherited = route !== 'fieldRow' && jsonValuesEqual(
      JSON.parse((await sharedDb.db.get<{properties_json: string}>(
        'SELECT properties_json FROM blocks WHERE id = ?', [host])).properties_json)[name],
      value)
    if (route === 'setProperty') {
      await setPropertyOnSettledSchema(repo, host, name, value)
    } else if (route === 'cellWrite') {
      await repo.tx(async tx => {
        const row = await tx.get(host)
        await tx.update(host, {properties: {...row!.properties, [name]: value}})
      }, SCOPE)
    } else {
      const fieldKey = await appendKey(host)
      const contents = empty ? [] : encodedPropertyValueToChildContents(projectionSchemas[preset], value)
      await repo.tx(async tx => {
        const fieldRowId = await tx.create({
          workspaceId: WS, parentId: host, orderKey: fieldKey,
          content: propertyFieldContent(def), referenceTargetId: def, isFieldForm: true,
        })
        const keys = keysBetween(null, null, contents.length)
        for (const [i, content] of contents.entries()) {
          await tx.create({workspaceId: WS, parentId: fieldRowId, orderKey: keys[i]!, content})
        }
      }, SCOPE)
    }
    if (!inherited) modeled.set(key, {host, def, value: empty ? undefined : value})
  }

  // Tombstones first: their consumers outlive them, and a live definition may
  // then take the name one of them held.
  for (const [i, id] of tombIds.entries()) {
    await createDefinition(repo, id, nameOf.get(id)!, presetOf.get(id)!)
    await awaitRegistry(repo, [id])
    for (const a of spec.assigns) {
      if (a.def % defIds.length !== liveIds.length + i) continue
      await assign(hostIds[a.host % hostIds.length]!, id, a.route, a.variant)
    }
    await repo.tx(tx => tx.delete(id), SCOPE)
    await awaitRegistry(repo, [id])
  }
  for (const id of liveIds) await createDefinition(repo, id, nameOf.get(id)!, presetOf.get(id)!)
  await awaitRegistry(repo, defIds)
  // Definition blocks host values too, their own included.
  const livePool = [...hostIds, ...liveIds]
  for (const a of spec.assigns) {
    const def = defIds[a.def % defIds.length]!
    if (!liveIds.includes(def)) continue
    await assign(livePool[a.host % livePool.length]!, def, a.route, a.variant)
  }
  // A tombstoned consumer: `tx.delete` leaves its field rows live.
  if (spec.deleteLastHost && hostIds.length > 1) {
    const last = hostIds.at(-1)!
    await repo.tx(tx => tx.delete(last), SCOPE)
    for (const key of [...modeled.keys()]) if (key.startsWith(`${last}|`)) modeled.delete(key)
  }
  await repo.awaitProcessors()

  // Sync-shaped rows, written raw so no processor reconciles them.
  for (const c of spec.cellOnly) {
    const host = livePool[c.host % livePool.length]!
    const def = liveIds[c.def % liveIds.length]!
    if (withFieldRow.has(`${host}|${def}`)) continue
    const preset = presetOf.get(def)!
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [host])
    const bag = {...JSON.parse(row.properties_json), [nameOf.get(def)!]: valueFor(preset, `cell/${host}`, 1, ++seq)}
    await sharedDb.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify(bag), host])
  }
  for (const [i, d] of spec.dups.entries()) {
    const key = [...withFieldRow][(d.host + d.def) % Math.max(1, withFieldRow.size)]
    if (key === undefined) continue
    const [host, def] = key.split('|') as [string, string]
    const preset = presetOf.get(def)!
    const contents = encodedPropertyValueToChildContents(
      projectionSchemas[preset], valueFor(preset, `dup${i}/${host}`, 2, ++seq))
    const dupId = `dup-${i}`
    if (await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?', [dupId])) continue
    await sharedDb.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
         reference_target_id, is_field_form, deleted, created_at, updated_at, user_updated_at,
         created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, '{}', ?, 1, 0, 1, 1, 1, 'user-1', 'user-1')`,
      [dupId, WS, host, await appendKey(host), propertyFieldContent(def), def])
    const keys = keysBetween(null, null, contents.length)
    for (const [j, content] of contents.entries()) {
      await sharedDb.db.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
           deleted, created_at, updated_at, user_updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, '{}', 0, 1, 1, 1, 'user-1', 'user-1')`,
        [`${dupId}-v${j}`, WS, dupId, keys[j]!, content])
    }
    modeled.delete(key)
  }

  const registry = repo.propertyDefinitions!
  for (const name of NAME_POOL) expect(registry.seedsByName.has(name), `${name} is a seed`).toBe(false)
  const seedIdByName = new Map(
    [SEED_NAME].map(name => [name, propertyDefinitionClaimantsForName(registry, name)[0]!]))
  return {
    repo, defIds, liveIds, tombIds, modeled, seedIdByName,
    nameFieldId: propertyDefinitionClaimantsForName(registry, propertyNameProp.name)[0]!,
  }
}

/** The batch, resolved against the names definitions hold at the start. Every
 *  definition is the target of at most one op. */
const resolveOps = (spec: CaseSpec, built: Built, states: ReadonlyMap<string, DefState>): Op[] => {
  const {liveIds, tombIds} = built
  const nameOf = (id: string) => states.get(id)!.name
  const taken = new Set([...states.values()].map(state => state.name))
  const fresh = NAME_POOL.filter(name => !taken.has(name))
  const freshName = (k: number) => fresh.length > 0 ? fresh[k % fresh.length]! : `fresh-${k % 2}`
  const ops: Op[] = []
  const targeted = new Set<string>()
  if (spec.perm) {
    const picked = liveIds.filter((_, i) => spec.perm!.members[i])
    const members = picked.length >= 2 ? picked : liveIds.slice(0, 2)
    // A cyclic shift by `s` of `n` members is gcd(n, s) cycles: swaps when
    // n = 2s, one long cycle when they are coprime.
    const shift = 1 + spec.perm.shift % (members.length - 1)
    for (const [i, id] of members.entries()) {
      ops.push({kind: 'rename', id, dest: nameOf(members[(i + shift) % members.length]!)})
      targeted.add(id)
    }
  }
  const targets = [...liveIds, ...tombIds]
  for (const x of spec.extra) {
    const id = targets[x.target % targets.length]!
    if (targeted.has(id)) continue
    const isTomb = tombIds.includes(id)
    let op: Op | null = null
    switch (x.kind) {
      case 'delete': op = isTomb ? null : {kind: 'delete', id}; break
      case 'revive': op = isTomb ? {kind: 'revive', id} : null; break
      case 'renameFresh': op = {kind: 'rename', id, dest: freshName(x.dest)}; break
      case 'renameTaken': op = {kind: 'rename', id, dest: nameOf(liveIds[x.dest % liveIds.length]!)}; break
      case 'renameTomb':
        op = tombIds.length > 0
          ? {kind: 'rename', id, dest: nameOf(tombIds[x.dest % tombIds.length]!)}
          : null
        break
      case 'renameSeed': op = {kind: 'rename', id, dest: SEED_NAME}; break
    }
    if (op?.kind === 'rename' && op.dest === nameOf(id)) op = isTomb ? {kind: 'revive', id} : null
    if (op === null) continue
    ops.push(op)
    targeted.add(id)
  }
  // Order within the tx is the caller's; the outcome must not depend on it.
  for (let i = ops.length - 1; i > 0; i--) {
    const j = spec.order[i % spec.order.length]! % (i + 1)
    ;[ops[i], ops[j]] = [ops[j]!, ops[i]!]
  }
  return ops
}

const chunk = (ops: readonly Op[], spec: CaseSpec): Op[][] => {
  // An empty tx writes nothing and records no undo step.
  if (ops.length === 0) return []
  if (spec.delivery !== 'split' || ops.length < 2) return [ops.slice()]
  const cuts = [...new Set(spec.cuts.map(c => 1 + c % (ops.length - 1)))].sort((a, b) => a - b)
  const chunks: Op[][] = []
  let start = 0
  for (const cut of [...cuts, ops.length]) {
    chunks.push(ops.slice(start, cut))
    start = cut
  }
  return chunks
}

// ── Oracles ──────────────────────────────────────────────────────────────────

/** Every value the model knows sits under its definition's CURRENT name. */
const checkValueModel = (built: Built, snap: Snapshot, everDeleted: ReadonlySet<string>, label: string) => {
  const states = defStatesOf(snap, built.defIds)
  for (const {host, def, value} of built.modeled.values()) {
    // A definition block hosts values too, and one deleted keeps its bag.
    if (everDeleted.has(def) || everDeleted.has(host)) continue
    const cell = cellOf(snap, host)
    const name = states.get(def)!.name
    if (value === undefined) {
      expect(name in cell, `${label}: ${host} holds no ${def} value under ${name}`).toBe(false)
    } else {
      expect(cell[name], `${label}: ${host}'s ${def} value under ${name}`).toEqual(value)
    }
  }
}

/** Every live definition with consumers is the only claimant of its name — a
 *  second one, ranked older, would have its consumers' cells read and written
 *  through it. */
const checkNameOwnership = (repo: Repo, built: Built, snap: Snapshot, label: string) => {
  const registry = repo.propertyDefinitions!
  for (const state of defStatesOf(snap, built.defIds).values()) {
    if (state.deleted || !hasConsumers(snap, state.id)) continue
    expect(propertyDefinitionClaimantsForName(registry, state.name),
      `${label}: claimants of ${state.name}`).toEqual([state.id])
  }
}

/** An accepted tx changes exactly what its renames imply and nothing else. */
const checkAcceptedStep = (
  built: Built, ops: readonly Op[], prediction: Prediction,
  before: Snapshot, after: Snapshot, label: string,
) => {
  expect([...after.keys()], `${label}: no row created or removed`).toEqual([...before.keys()])
  const targets = new Map(ops.map(op => [op.id, op]))
  const presetOf = defStatesOf(before, built.defIds)
  // The name value child under each renamed definition's own name field row.
  const nameValueOwner = new Map<string, string>()
  for (const op of ops) {
    if (op.kind !== 'rename') continue
    for (const fieldRow of fieldRowsFor(before, op.id, built.nameFieldId)) {
      for (const value of liveChildren(before, fieldRow.id)) nameValueOwner.set(value.id, op.id)
    }
  }
  for (const [id, b] of before) {
    const a = after.get(id)!
    const op = targets.get(id)
    const ownerOp = nameValueOwner.has(id) ? targets.get(nameValueOwner.get(id)!) : undefined
    if (ownerOp?.kind === 'rename') {
      expect(rowView(a, [...TIMESTAMPS, 'content']), `${label}: name value ${id}`)
        .toEqual(rowView(b, [...TIMESTAMPS, 'content']))
      expect(a.content, `${label}: name value ${id}`).toBe(ownerOp.dest)
      continue
    }
    // On a consumer still live after the tx (one this tx deletes keeps its
    // bag, #1023): drop every renamed definition's old key, then publish each
    // one's projection under its new key — two phases, so a key one rename
    // leaves and another arrives at holds the arrival.
    const consumed = a.deleted === 0
      ? [...prediction.candidates].filter(([fieldId]) => fieldRowsFor(after, id, fieldId).length > 0)
      : []
    const expectedBag = cellOf(before, id)
    for (const [, {oldName}] of consumed) delete expectedBag[oldName]
    for (const [fieldId, {newName}] of consumed) {
      const projection = projectionOf(after, id, fieldId, presetOf.get(fieldId)!.preset)
      if (projection.absent || projection.value === undefined) delete expectedBag[newName]
      else expectedBag[newName] = projection.value
    }
    if (op?.kind === 'rename') expectedBag[propertyNameProp.name] = op.dest
    const expectedDeleted = op?.kind === 'delete' ? 1 : op ? 0 : b.deleted
    // Only the edited definition row is a user write. The re-key is machinery:
    // it advances the row version sync needs, never `user_updated_at`.
    const omit = op ? ['properties_json', 'deleted', ...TIMESTAMPS] : ['properties_json', 'updated_at']
    expect(rowView(a, omit), `${label}: row ${id}`).toEqual(rowView(b, omit))
    expect(a.deleted, `${label}: ${id} deleted`).toBe(expectedDeleted)
    expect(cellOf(after, id), `${label}: cell of ${id}`).toEqual(expectedBag)
  }
}

/** The changed definition rows a tx produced, as the processor saw them. */
const changedDefinitionRows = (ops: readonly Op[], before: Snapshot, after: Snapshot): ChangedRow[] =>
  ops.map(op => ({
    id: op.id,
    before: parseBlockRow(before.get(op.id)!),
    after: parseBlockRow(after.get(op.id)!),
  }))

/** Re-running the processor over the same changed rows writes nothing. */
const checkRerunIsNoop = async (built: Built, rows: ChangedRow[], label: string) => {
  const before = await snapshot()
  rerunRows = rows
  try {
    await built.repo.tx(async tx => {
      await tx.update(SCRATCH, {content: label})
      tx.emitEvent(RERUN_EVENT, null)
    }, SCOPE)
  } finally {
    rerunRows = []
  }
  expectSameRows(await snapshot(), before, [], `${label}: processor re-run`, new Set([SCRATCH]))
}

const undoRedo = async (built: Built, count: number, direction: 'undo' | 'redo') => {
  for (let i = 0; i < count; i++) {
    const moved = direction === 'undo'
      ? await built.repo.undo(ChangeScope.BlockDefault)
      : await built.repo.redo(ChangeScope.BlockDefault)
    expect(moved, `${direction} step ${i + 1} of ${count}`).toBe(true)
    await awaitRegistry(built.repo, built.defIds)
  }
  await built.repo.awaitProcessors()
}

/** The same ops, one definition per tx, through a temporary name each — tx by
 *  tx, since whether a definition block that hosts values is re-keyed depends
 *  on whether its deletion has landed. Within one tx: deletes (a parent the
 *  tx deletes is never re-keyed), then every live definition to its
 *  temporary name, then every revived one (whose old name a live definition
 *  may hold until it has moved), then each on to its final name, then plain
 *  revivals — an order in which no single step is refused whenever the tx
 *  was not. */
const referenceRoute = async (built: Built, txs: readonly (readonly Op[])[], pre: Snapshot) => {
  for (const ops of txs) {
    const renames = ops
      .filter((op): op is Extract<Op, {kind: 'rename'}> => op.kind === 'rename')
      .sort((a, b) => pre.get(a.id)!.deleted - pre.get(b.id)!.deleted)
    const steps: Op[] = [
      ...ops.filter(op => op.kind === 'delete'),
      ...renames.map(op => ({...op, dest: `tmp-${op.id}`})),
      ...renames,
      ...ops.filter(op => op.kind === 'revive'),
    ]
    for (const [i, step] of steps.entries()) {
      try {
        await applyOps(built.repo, [step])
      } catch (error) {
        throw new Error(
          `reference route refused step ${i} (${JSON.stringify(step)}): ${String(error)}`,
          {cause: error},
        )
      }
      await awaitRegistry(built.repo, built.defIds)
    }
  }
  await built.repo.awaitProcessors()
}

/** Deliver `post`'s rows to the current (pre-state) device the way sync does:
 *  staged into `blocks_synced` with a newer stamp, materialized by the
 *  observer. */
const deliverBySync = async (
  built: Built, ops: readonly Op[], post: Snapshot, order: CaseSpec['syncOrder'],
) => {
  const current = await snapshot()
  // Uploads are done: nothing local is pending against the arriving rows.
  await sharedDb.db.execute('DELETE FROM ps_crud')
  const storage = (row: Row) => rowView(row, [...SYNC_STAMPED, 'reference_target_id', 'is_field_form'])
  const changed = [...post.values()].filter(row =>
    JSON.stringify(storage(row)) !== JSON.stringify(storage(current.get(row.id)!)))
  // A definition block is a root, so its subtree is the definition's side.
  const definitionSide = new Set(ops.map(op => op.id))
  const isDefinitionSide = (row: Row): boolean => definitionSide.has(rootOf(post, row))
  const batches = order === 'together'
    ? [changed]
    : order === 'defsFirst'
      ? [changed.filter(isDefinitionSide), changed.filter(row => !isDefinitionSide(row))]
      : [changed.filter(row => !isDefinitionSide(row)), changed.filter(isDefinitionSide)]
  let stamp = 9_000_000_000_000
  for (const batch of batches) {
    for (const row of batch) {
      stamp += 1
      await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
        ...parseBlockRow(row), updatedAt: stamp, userUpdatedAt: stamp, updatedBy: 'remote',
      }))
    }
    await built.repo.flushSyncObserver()
  }
  await awaitRegistry(built.repo, built.defIds)
  await built.repo.awaitProcessors()
}

const rootOf = (snap: Snapshot, row: Row): string => {
  let cursor = row
  while (cursor.parent_id !== null && snap.has(cursor.parent_id)) cursor = snap.get(cursor.parent_id)!
  return cursor.id
}

// ── The property ─────────────────────────────────────────────────────────────

/** Runs one case through every oracle; resolves to how many of its txs
 *  committed. */
const runCase = async (spec: CaseSpec): Promise<number> => {
  const repo = await openRepo(spec)
  try {
    return await checkCase(spec, await build(spec, repo))
  } finally {
    await releaseRepo(repo)
  }
}

const checkCase = async (spec: CaseSpec, built: Built): Promise<number> => {
  const {repo, defIds} = built
  const pre = await snapshot()
  const everDeleted = new Set(built.tombIds)
  checkValueModel(built, pre, everDeleted, 'pre-state')

  const ops = resolveOps(spec, built, defStatesOf(pre, defIds))
  const accepted: Op[][] = []
  for (const [i, chunkOps] of chunk(ops, spec).entries()) {
    const label = `tx ${i}`
    const before = await snapshot()
    const prediction = predict(chunkOps, defStatesOf(before, defIds), before, built.seedIdByName)
    let rejection: unknown = null
    try {
      await applyOps(repo, chunkOps)
    } catch (error) {
      rejection = error
    }
    await repo.awaitProcessors()
    const after = await snapshot()
    if (prediction.refusal !== null) {
      expect(rejection, `${label}: refused`).toBeInstanceOf(ProcessorRejection)
      expect((rejection as ProcessorRejection).code, `${label}: refusal code`).toBe(prediction.refusal)
      expectSameRows(after, before, [], `${label}: a refused tx changes nothing`)
      continue
    }
    if (rejection !== null) throw rejection
    accepted.push(chunkOps)
    for (const op of chunkOps) if (op.kind === 'delete' || op.kind === 'revive') everDeleted.add(op.id)
    for (const op of chunkOps) if (op.kind === 'rename' && before.get(op.id)!.deleted === 1) everDeleted.add(op.id)
    checkAcceptedStep(built, chunkOps, prediction, before, after, label)
    await awaitRegistry(repo, defIds)
    checkValueModel(built, after, everDeleted, label)
    checkNameOwnership(repo, built, after, label)
  }
  const post = await snapshot()
  if (accepted.length === 0) return 0
  const acceptedOps = accepted.flat()

  await undoRedo(built, accepted.length, 'undo')
  expectSameRows(await snapshot(), pre, TIMESTAMPS, 'undo restores the pre-state')
  await undoRedo(built, accepted.length, 'redo')
  expectSameRows(await snapshot(), post, TIMESTAMPS, 'redo restores the post-state')
  await undoRedo(built, accepted.length, 'undo')

  if (spec.delivery === 'sync') {
    await deliverBySync(built, acceptedOps, post, spec.syncOrder)
    const delivered = await snapshot()
    expectSameRows(delivered, post, SYNC_STAMPED, 'sync delivery')
    checkValueModel(built, delivered, everDeleted, 'sync delivery')
    checkNameOwnership(repo, built, delivered, 'sync delivery')
    await checkRerunIsNoop(built, changedDefinitionRows(acceptedOps, pre, delivered), 'receiver')
    return accepted.length
  }
  await referenceRoute(built, accepted, pre)
  const reference = await snapshot()
  expectSameRows(reference, post, [...TIMESTAMPS], 'reference route')
  checkValueModel(built, reference, everDeleted, 'reference route')
  if (spec.delivery === 'single') {
    await checkRerunIsNoop(built, changedDefinitionRows(acceptedOps, pre, reference), 'initiator')
  }
  return accepted.length
}

/** Fixed cases every tier runs, so the oracles always meet the shapes this
 *  suite exists for whatever the seed draws. Host pool: hosts, then live
 *  definition blocks. */
const CANARY_BASE: Omit<CaseSpec, 'perm' | 'delivery'> = {
  defs: [
    {nameIdx: 0, preset: 'string'}, {nameIdx: 1, preset: 'number'},
    {nameIdx: 2, preset: 'string-list'},
  ],
  tombs: [{nameIdx: 1, preset: 'boolean', sameAsLive: true}],
  // host-1 nested under host-0.
  hostCount: 2, hostParents: [0, 1, 0, 0], deleteLastHost: false,
  assigns: [
    {host: 0, def: 0, route: 'setProperty', variant: 1},
    {host: 0, def: 1, route: 'cellWrite', variant: 1},
    {host: 0, def: 2, route: 'fieldRow', variant: 2},
    {host: 1, def: 0, route: 'fieldRow', variant: 1},
    {host: 1, def: 2, route: 'setProperty', variant: 0},
    {host: 1, def: 3, route: 'setProperty', variant: 1},
    // def-0's own block holds a def-1 value.
    {host: 2, def: 1, route: 'setProperty', variant: 1},
  ],
  cellOnly: [{host: 1, def: 1}], dups: [{host: 0, def: 0}],
  extra: [], order: [1, 2, 0, 3, 1, 0, 2, 1], cuts: [0], syncOrder: 'together', prngSeed: 1,
}
const CANARIES: Array<[string, CaseSpec]> = [
  ['a 3-cycle across three codecs', {...CANARY_BASE, perm: {members: [true, true, true, false, false], shift: 0}, delivery: 'single'}],
  ['a swap delivered by sync', {...CANARY_BASE, perm: {members: [true, false, true, false, false], shift: 0}, delivery: 'sync'}],
]

describe('N-way property-definition renames', () => {
  it.each(CANARIES)('canary: %s commits and passes every oracle', async (_, spec) => {
    expect(await guard.run(spec.prngSeed, () => runCase(spec))).toBeGreaterThan(0)
  }, 30_000)

  it('conserve every value, refuse exactly the contested batches, and replay exactly', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async spec => {
        await guard.run(spec.prngSeed, () => runCase(spec))
      }),
      fuzzParams(15),
    )
  }, fuzzTestTimeout())
})
