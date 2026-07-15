// @vitest-environment node
/**
 * Stateful fuzz suite for property-seed materialization + the tx-layer
 * seed-definition write guard (PR #364, schema-unification §5.1).
 *
 * Random interleavings of `materializePropertySeeds`, user-scope tamper
 * attempts, system-scope (Automation) lifecycle writes, and deterministic-id
 * poisoning run against a real test repo. The v1 invariant under test: a
 * materialized seed definition's bag is WHOLLY CODE-OWNED — no user-scope
 * (BlockDefault) write may create, rewrite, or delete it through any tx
 * primitive (txEngine.ts `assertSeedDefinitionMutable`), while Automation
 * writes and materialization itself stay unaffected.
 *
 * Oracles (each cited from the target's code/docs):
 *  - materialization idempotence: a successful pass immediately re-run over
 *    the same declarations reports zero work (definitionSeeds.ts:231-243
 *    treats live rows as done and never repairs payloads);
 *  - batch atomicity under poisoning: one deterministic id occupied by a
 *    row without valid seed provenance aborts the WHOLE pass with no rows
 *    written (definitionSeeds.ts:193-229 — "one poisoned id intentionally
 *    aborts the whole batch");
 *  - user-scope writes violating the seed invariant throw
 *    SeededDefinitionWriteError and leave the row byte-identical. The
 *    invariant is ONE commit-time check over the tx snapshots map
 *    (`assertNoSeedDefinitionWrites`, enforced in commitPipeline): a row
 *    may not BECOME provenance-valid (forgeCreate / forgeUpdate — the id
 *    is publicly computable, uuidv5(workspaceId:seedKey)), and a
 *    provenance-valid row's bag may not change nor the row be tombstoned
 *    (userTamperUpdate / userSetProperty / userRestoreTamper /
 *    userDelete-on-live). This suite found the create and
 *    restore-with-properties forge paths under the older per-primitive
 *    guards; the update-INTO-validity path surfaced when the per-site
 *    design was probed, motivating the commit-time consolidation;
 *  - Automation-scope writes succeed (materialization and the §13
 *    revision-upgrade path run under Automation, txEngine.ts:346-353);
 *  - restore preserves a tombstone's existing bag (definitionSeeds.ts:267-270
 *    restores with `skipMetadata` and no payload repair);
 *  - registry tie-in: after any interleaving, projecting the live rows via
 *    `parsePropertyDefinitionMetadata` and building the registry resolves
 *    every pool declaration to its deterministic field id (the stateful
 *    layer must land in states the resolver layer accepts).
 *
 * Shared-DB discipline: each case resets the shared DB; the module-level
 * `inFlightCase` barrier (docs/fuzzing.md §6) protects later tests/cleanup
 * from a deep-tier interrupt's abandoned case.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {ChangeScope, SeededDefinitionWriteError} from '@/data/api'
import {
  canonicalPropertySeedProperties,
  materializePropertySeeds,
  propertyDefinitionBlockId,
} from '@/data/definitionSeeds'
import {parsePropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {buildPropertyDefinitionRegistry, type ProjectedPropertyDefinition} from '@/data/propertyDefinitionRegistry'
import {propertySchemaResolverForWorkspace} from '@/data/internals/propertySchemaResolution'
import {propertyHiddenProp, propertyNameProp} from '@/data/properties'
import {propertiesPageBlockId} from '@/data/propertiesPage'
import {seedProperty, type AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import type {BlockData, PropertyHandle} from '@/data/api'

const WS = 'ws-seed-fuzz'

const POOL: readonly AnyPropertySeedDeclaration[] = [
  seedProperty({
    seedKey: 'system:kernel-data/property/fz-one',
    revision: 1,
    name: 'fuzz:one',
    preset: 'string',
    defaultValue: 'one',
    changeScope: ChangeScope.UserPrefs,
  }),
  seedProperty({
    seedKey: 'fuzz-plugin/property/fz-two',
    revision: 2,
    name: 'fuzz:two',
    preset: 'number',
    changeScope: ChangeScope.BlockDefault,
    hidden: true,
  }),
  seedProperty({
    seedKey: 'fuzz-plugin/property/fz-three',
    revision: 1,
    name: 'fuzz:three',
    preset: 'optional-string',
    defaultValue: undefined,
    changeScope: ChangeScope.BlockDefault,
  }),
  seedProperty({
    seedKey: 'system:kernel-data/property/fz-four',
    revision: 1,
    name: 'fuzz:four',
    preset: 'boolean',
    defaultValue: true,
    changeScope: ChangeScope.Automation,
  }),
]
const IDS = POOL.map(seed => propertyDefinitionBlockId(WS, seed.seedKey))

type OpSpec =
  | {readonly op: 'materialize'; readonly mask: readonly number[]}
  | {readonly op: 'userTamperUpdate'; readonly idx: number}
  | {readonly op: 'userSetProperty'; readonly idx: number}
  | {readonly op: 'userDelete'; readonly idx: number}
  | {readonly op: 'userRestorePlain'; readonly idx: number}
  | {readonly op: 'userRestoreTamper'; readonly idx: number}
  | {readonly op: 'automationRename'; readonly idx: number}
  | {readonly op: 'automationDelete'; readonly idx: number}
  | {readonly op: 'poison'; readonly idx: number}
  | {readonly op: 'forgeCreate'; readonly idx: number}
  | {readonly op: 'forgeUpdate'; readonly idx: number}

const idxArb = fc.nat(POOL.length - 1)
const opArb: fc.Arbitrary<OpSpec> = fc.oneof(
  {arbitrary: fc.record({op: fc.constant('materialize' as const), mask: fc.shuffledSubarray([0, 1, 2, 3], {minLength: 1})}), weight: 3},
  {arbitrary: fc.record({op: fc.constant('userTamperUpdate' as const), idx: idxArb}), weight: 1},
  {arbitrary: fc.record({op: fc.constant('userSetProperty' as const), idx: idxArb}), weight: 1},
  {arbitrary: fc.record({op: fc.constant('userDelete' as const), idx: idxArb}), weight: 1},
  {arbitrary: fc.record({op: fc.constant('userRestorePlain' as const), idx: idxArb}), weight: 1},
  {arbitrary: fc.record({op: fc.constant('userRestoreTamper' as const), idx: idxArb}), weight: 1},
  {arbitrary: fc.record({op: fc.constant('automationRename' as const), idx: idxArb}), weight: 1},
  {arbitrary: fc.record({op: fc.constant('automationDelete' as const), idx: idxArb}), weight: 2},
  {arbitrary: fc.record({op: fc.constant('poison' as const), idx: idxArb}), weight: 1},
  {arbitrary: fc.record({op: fc.constant('forgeCreate' as const), idx: idxArb}), weight: 1},
  {arbitrary: fc.record({op: fc.constant('forgeUpdate' as const), idx: idxArb}), weight: 1},
)
const opsArb = fc.array(opArb, {maxLength: 14})

/** Per-seed model. `bag` is the exact expected properties bag; it is only
 * tracked for provenance-valid rows (poisoned occupants are untracked). */
interface SeedModel {
  status: 'absent' | 'live' | 'tombstone' | 'poisoned'
  bag: Record<string, unknown> | null
}

interface RowSnapshot {
  readonly id: string
  readonly deleted: number
  readonly properties_json: string
  readonly content: string
  readonly updated_at: number
}

const snapshotRows = async (db: TestDb['db']): Promise<string> => {
  const rows = await db.getAll<RowSnapshot>(
    `SELECT id, deleted, properties_json, content, updated_at FROM blocks
     WHERE id IN (${IDS.map(() => '?').join(', ')}) ORDER BY id`,
    [...IDS],
  )
  return JSON.stringify(rows)
}

const verifyModel = async (db: TestDb['db'], model: readonly SeedModel[]): Promise<void> => {
  for (const [idx, entry] of model.entries()) {
    const row = await db.getOptional<{deleted: number; properties_json: string}>(
      'SELECT deleted, properties_json FROM blocks WHERE id = ?', [IDS[idx]!],
    )
    if (entry.status === 'absent') {
      expect(row, `seed ${idx} should be absent`).toBeFalsy()
      continue
    }
    expect(row, `seed ${idx} should exist (${entry.status})`).toBeTruthy()
    if (entry.status === 'live') expect(row!.deleted, `seed ${idx} live`).toBe(0)
    if (entry.status === 'tombstone') expect(row!.deleted, `seed ${idx} tombstoned`).toBe(1)
    if (entry.bag !== null) {
      expect(JSON.parse(row!.properties_json), `seed ${idx} bag is code-owned`).toEqual(entry.bag)
    }
  }
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await inFlightCase?.catch(() => {})
  await sharedDb.cleanup()
})

/** See docs/fuzzing.md §6 — the deep tier's `interruptAfterTimeLimit`
 * abandons the executing case without awaiting it; everything that touches
 * the shared DB afterwards must barrier on this. */
let inFlightCase: Promise<void> | null = null

const runCase = async (ops: readonly OpSpec[]): Promise<void> => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}) as {repo: Repo}
  repo.setActiveWorkspaceId(WS)
  await repo.ensureSystemPages(WS)

  const model: SeedModel[] = POOL.map(() => ({status: 'absent', bag: null}))

  for (const [position, op] of ops.entries()) {
    switch (op.op) {
      case 'materialize': {
        const chosen = op.mask.map(idx => POOL[idx]!)
        const poisonedChosen = op.mask.some(idx => model[idx]!.status === 'poisoned')
        if (poisonedChosen) {
          // One invalid deterministic-id occupant aborts the whole batch
          // before any write (definitionSeeds.ts:222-229, 249-262).
          const before = await snapshotRows(sharedDb.db)
          await expect(materializePropertySeeds(repo, WS, chosen)).rejects.toThrow()
          expect(await snapshotRows(sharedDb.db), 'aborted pass wrote nothing').toBe(before)
          break
        }
        const expected = {
          created: op.mask.filter(idx => model[idx]!.status === 'absent').length,
          restored: op.mask.filter(idx => model[idx]!.status === 'tombstone').length,
          skippedReadOnly: false,
        }
        expect(await materializePropertySeeds(repo, WS, chosen)).toEqual(expected)
        for (const idx of op.mask) {
          const entry = model[idx]!
          if (entry.status === 'absent') entry.bag = canonicalPropertySeedProperties(POOL[idx]!)
          // A restore preserves whatever bag the tombstone carried
          // (definitionSeeds.ts:267-270) — `bag` already tracks it.
          entry.status = 'live'
        }
        // Idempotence: an immediate second pass over the same declarations
        // reports zero work (definitionSeeds.ts:231-243).
        expect(await materializePropertySeeds(repo, WS, chosen))
          .toEqual({created: 0, restored: 0, skippedReadOnly: false})
        break
      }
      case 'userTamperUpdate': {
        const entry = model[op.idx]!
        if (entry.status !== 'live' && entry.status !== 'tombstone') break
        const before = await snapshotRows(sharedDb.db)
        await expect(repo.tx(
          tx => tx.update(IDS[op.idx]!, {
            properties: {
              ...canonicalPropertySeedProperties(POOL[op.idx]!),
              [propertyNameProp.name]: `hacked-${position}`,
            },
          }),
          {scope: ChangeScope.BlockDefault},
        )).rejects.toThrow(SeededDefinitionWriteError)
        expect(await snapshotRows(sharedDb.db), 'rejected tamper wrote nothing').toBe(before)
        break
      }
      case 'userSetProperty': {
        const entry = model[op.idx]!
        if (entry.status !== 'live' && entry.status !== 'tombstone') break
        // Flip hidden so the write CHANGES the bag: the commit-time guard
        // deliberately allows a value-equal write (nothing changed, so
        // code-ownership isn't violated — a semantics change from the old
        // per-primitive guard, which rejected before looking at the value;
        // caught by this suite's deep tier when the op wrote a constant).
        const before = await snapshotRows(sharedDb.db)
        await expect(repo.tx(
          tx => tx.setProperty(IDS[op.idx]!, propertyHiddenProp, !POOL[op.idx]!.hidden),
          {scope: ChangeScope.BlockDefault},
        )).rejects.toThrow(SeededDefinitionWriteError)
        expect(await snapshotRows(sharedDb.db), 'rejected setProperty wrote nothing').toBe(before)
        break
      }
      case 'userDelete': {
        const entry = model[op.idx]!
        if (entry.status === 'live') {
          // Live seed rows may not be tombstoned by a user write
          // (assertNoSeedDefinitionWrites' deleted-transition rule).
          await expect(repo.tx(
            tx => tx.delete(IDS[op.idx]!),
            {scope: ChangeScope.BlockDefault},
          )).rejects.toThrow(SeededDefinitionWriteError)
        } else if (entry.status === 'tombstone') {
          // Deleting an already-tombstoned row writes nothing (txEngine's
          // delete no-ops), so the commit-time guard has nothing to
          // reject — a legal no-op.
          await repo.tx(tx => tx.delete(IDS[op.idx]!), {scope: ChangeScope.BlockDefault})
        }
        break
      }
      case 'forgeUpdate': {
        const entry = model[op.idx]!
        if (entry.status !== 'poisoned') break
        // The update-INTO-validity direction: a plain occupant of the
        // deterministic id may not have the provenance-valid bag written
        // onto it — that would forge a code-owned definition just like
        // forgeCreate (the per-site guards checked only the `before` row
        // and missed this; the commit-time check covers both directions).
        const before = await snapshotRows(sharedDb.db)
        await expect(repo.tx(
          tx => tx.update(IDS[op.idx]!, {properties: canonicalPropertySeedProperties(POOL[op.idx]!)}),
          {scope: ChangeScope.BlockDefault},
        )).rejects.toThrow(SeededDefinitionWriteError)
        expect(await snapshotRows(sharedDb.db), 'rejected forge-update wrote nothing').toBe(before)
        break
      }
      case 'userRestorePlain': {
        const entry = model[op.idx]!
        if (entry.status !== 'tombstone') break
        // A plain user restore keeps the code-owned bag intact, so it is
        // NOT a bag write; it resurrects the row like materialization would.
        await repo.tx(tx => tx.restore(IDS[op.idx]!), {scope: ChangeScope.BlockDefault})
        entry.status = 'live'
        break
      }
      case 'userRestoreTamper': {
        const entry = model[op.idx]!
        if (entry.status !== 'tombstone') break
        // restore-with-properties rewrites the code-owned bag exactly like
        // update-with-properties does — it must be guarded the same way.
        const before = await snapshotRows(sharedDb.db)
        await expect(repo.tx(
          tx => tx.restore(IDS[op.idx]!, {
            properties: {
              ...canonicalPropertySeedProperties(POOL[op.idx]!),
              [propertyNameProp.name]: `forged-${position}`,
            },
          }),
          {scope: ChangeScope.BlockDefault},
        )).rejects.toThrow(SeededDefinitionWriteError)
        expect(await snapshotRows(sharedDb.db), 'rejected restore-tamper wrote nothing').toBe(before)
        break
      }
      case 'automationRename': {
        const entry = model[op.idx]!
        if (entry.status !== 'live' && entry.status !== 'tombstone') break
        const renamed = {
          ...entry.bag!,
          [propertyNameProp.name]: `renamed-${position}`,
        }
        await repo.tx(
          tx => tx.update(IDS[op.idx]!, {properties: renamed}),
          {scope: ChangeScope.Automation},
        )
        entry.bag = renamed
        break
      }
      case 'automationDelete': {
        const entry = model[op.idx]!
        if (entry.status !== 'live') break
        await repo.tx(tx => tx.delete(IDS[op.idx]!), {scope: ChangeScope.Automation})
        entry.status = 'tombstone'
        break
      }
      case 'poison': {
        const entry = model[op.idx]!
        if (entry.status !== 'absent') break
        // An ordinary user block that happens to occupy the deterministic id
        // (no provenance bag — creating it is legal, it is just a block).
        await repo.tx(async tx => {
          await tx.create({
            id: IDS[op.idx]!,
            workspaceId: WS,
            parentId: propertiesPageBlockId(WS),
            orderKey: 'a0',
            content: 'innocent occupant',
            properties: {},
          })
        }, {scope: ChangeScope.BlockDefault})
        entry.status = 'poisoned'
        break
      }
      case 'forgeCreate': {
        const entry = model[op.idx]!
        if (entry.status !== 'absent') break
        // The deterministic id is publicly computable, so a user-scope create
        // carrying a provenance-VALID bag would forge a code-owned definition
        // that materialization then trusts forever (probe passes, row live →
        // skipped, bag never repaired). It must be rejected like every other
        // user-scope seed-bag write.
        await expect(repo.tx(async tx => {
          await tx.create({
            id: IDS[op.idx]!,
            workspaceId: WS,
            parentId: propertiesPageBlockId(WS),
            orderKey: 'a0',
            content: POOL[op.idx]!.name,
            properties: canonicalPropertySeedProperties(POOL[op.idx]!),
          })
        }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(SeededDefinitionWriteError)
        const row = await sharedDb.db.getOptional(
          'SELECT id FROM blocks WHERE id = ?', [IDS[op.idx]!],
        )
        expect(row, 'rejected forge-create wrote nothing').toBeFalsy()
        break
      }
    }
    await verifyModel(sharedDb.db, model)
  }

  // Registry tie-in: project the live rows the way the schemas service does
  // and require every pool declaration to resolve to its deterministic field
  // id — whatever states the interleaving reached must be states the
  // resolver layer accepts (registry semantics fuzzed in depth by
  // propertyDefinitionRegistry.fuzz.test.ts).
  const projected = new Map<string, ProjectedPropertyDefinition>()
  for (const id of IDS) {
    const row = await sharedDb.db.getOptional<{
      id: string; workspace_id: string; parent_id: string | null; order_key: string
      content: string; properties_json: string; references_json: string
      created_at: number; updated_at: number; user_updated_at: number
      created_by: string; updated_by: string; deleted: number
    }>('SELECT * FROM blocks WHERE id = ?', [id])
    if (!row) continue
    const data: BlockData = {
      id: row.id,
      workspaceId: row.workspace_id,
      parentId: row.parent_id,
      orderKey: row.order_key,
      content: row.content,
      properties: JSON.parse(row.properties_json) as Record<string, unknown>,
      references: JSON.parse(row.references_json) as BlockData['references'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userUpdatedAt: row.user_updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      deleted: row.deleted === 1,
    }
    const metadata = parsePropertyDefinitionMetadata(data)
    if (metadata) projected.set(metadata.fieldId, {metadata})
  }
  const snapshot = buildPropertyDefinitionRegistry({
    workspaceId: WS,
    legacySchemas: new Map(),
    projectedDefinitions: projected,
    seeds: POOL,
  })
  const resolver = propertySchemaResolverForWorkspace(snapshot, WS)
  for (const [idx, seed] of POOL.entries()) {
    const result = resolver.resolve(seed as PropertyHandle<unknown>)
    expect(result.status, `pool seed ${idx} resolves post-interleaving`).toBe('resolved')
    if (result.status === 'resolved') expect(result.schema.fieldId).toBe(IDS[idx])
  }
}

describe('seed materialization + write-guard interleavings', () => {
  it('keep materialized definition bags code-owned under any op order', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async ops => {
        const run = runCase(ops)
        inFlightCase = run
        await run
      }),
      fuzzParams(8),
    )
  }, fuzzTestTimeout())

  // Non-vacuity canary: a crafted sequence must actually traverse the
  // states the random sweep claims to cover — created, tampered-and-
  // rejected, tombstoned, restored, poisoned-and-aborted.
  it('op set reaches create, reject, tombstone, restore, and poison-abort', async () => {
    await inFlightCase?.catch(() => {})
    await runCase([
      {op: 'forgeCreate', idx: 0},
      {op: 'materialize', mask: [0, 1]},
      {op: 'userTamperUpdate', idx: 0},
      {op: 'userSetProperty', idx: 1},
      {op: 'userDelete', idx: 0},
      {op: 'automationRename', idx: 1},
      {op: 'automationDelete', idx: 1},
      {op: 'userRestoreTamper', idx: 1},
      {op: 'userRestorePlain', idx: 1},
      {op: 'poison', idx: 2},
      {op: 'forgeUpdate', idx: 2},
      {op: 'materialize', mask: [2, 3]},
      {op: 'materialize', mask: [3]},
    ])
  }, fuzzTestTimeout())
})
