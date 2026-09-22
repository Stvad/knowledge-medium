// @vitest-environment node
/**
 * Definition CHANGE fan-out (docs/properties-as-blocks-migration.html §7/§9):
 * renaming or re-typing a property definition re-keys and re-encodes every
 * consuming parent's cell.
 *
 * ONE path, and it is synchronous: `core.migratePropertyDefinition`
 * (`internals/propertyDefinitionChangeProcessor.ts`) fires inside the same
 * `repo.tx` that edits the definition block, so the edit and its fan-out land
 * as ONE undoable step on the client that made it, and every other client
 * receives finished rows by sync (#1013 — this replaced a deferred per-device
 * pass that re-derived the change from a registry diff, #995). Field rows are
 * id-addressed (`((fieldId))`, §7) either way, so nothing retitles them — only
 * the name-keyed cell re-keys and the value children re-encode.
 *
 * The definition blocks here carry a REAL `property-schema:preset`, so the
 * app's own `userSchemasProjector` builds their behavior and a re-type is what
 * it is in production: a tx that rewrites that one property.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChangeScope,
  codecs,
  type AnyCodec,
  type AnyPropertySchema,
  type AnyValuePresetCore,
  type ProcessorRejection,
} from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { valuePresetCoresFacet } from '@/data/facets'
import { isGrammarShapedLabel, isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import {
  presetConfigProp,
  presetIdProp,
  propertyChangeScopeProp,
  propertyNameProp,
} from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { propertyDefinitionClaimantsForName } from './propertyDefinitionRegistry'
import {
  consumingParentIds,
  contestedChanges,
  type NameClaim,
} from './internals/propertyDefinitionChangeProcessor'
import { graphBackfillClaimBlockId } from './internals/graphBackfillClaim'
import { PROPERTY_CELL_BACKFILL_ID } from './internals/propertyCellBackfill'
import { MIGRATION_CLAIM_TYPE } from './blockTypes'
import {
  addBlockTypeToProperties,
  migrationClaimantProp,
  migrationClaimedAtProp,
  migrationCompletedAtProp,
} from './properties'
import type { Repo } from './repo'
import {
  beginPropertyDefinitionFanout,
  markPropertyDefinitionFanoutRunning,
  propertyDefinitionFanout,
  __resetPropertyDefinitionFanoutForTests,
} from './propertyDefinitionFanout'

const WS = 'ws-def-change'
const FIELD_ID = 'field-status-change'

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
afterEach(() => { vi.useRealTimers() })

const seedWorkspace = async (
  propertiesMigration: string, id = WS,
): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, ?)`,
    [id, propertiesMigration],
  )
}

/** A REAL property-schema definition block: `types: ['property-schema']` plus
 *  name / change-scope / PRESET. The preset is what makes this the production
 *  shape — `userSchemasProjector` builds real behavior from it, so the registry
 *  entry the processor's identity gate consults and the codec it re-encodes
 *  under both come from this row, exactly as they do in the app. */
const createDefinition = async (
  repo: Repo, fieldId: string, name: string, presetId: string, workspaceId = WS,
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id: fieldId, workspaceId, parentId: null, orderKey: `k-${fieldId}`, content: name,
      properties: {
        types: [PROPERTY_SCHEMA_TYPE],
        [propertyNameProp.name]: name,
        [propertyChangeScopeProp.name]: ChangeScope.BlockDefault,
        [presetIdProp.name]: presetId,
      },
    })
  }, {scope: ChangeScope.BlockDefault})
}

/** The projector reacts to the definition row asynchronously, so every test
 *  fences on the registry carrying what it is about to depend on. Codec type is
 *  part of the fence, not just the name: a re-type test that ran before the
 *  BUILD settled would resolve the old codec and pass for the wrong reason. */
const awaitDefinition = async (
  repo: Repo, name: string, codecType: string,
): Promise<AnyPropertySchema> => {
  let schema: AnyPropertySchema | undefined
  await vi.waitFor(() => {
    schema = repo.propertySchemas.get(name)
    if (schema?.codec.type !== codecType) {
      throw new Error(
        `[test] ${name} is ${schema?.codec.type ?? 'absent'} in the registry, want ${codecType}`,
      )
    }
  }, {timeout: 3000})
  return schema!
}

/** `setProperty` resolves a plain schema by INSTANCE identity against the
 *  ambient map, so a value write has to hand back the registry's own object. */
const schemaFor = (repo: Repo, name: string): AnyPropertySchema => {
  const schema = repo.propertySchemas.get(name)
  if (!schema) throw new Error(`[test] no registered schema for ${name}`)
  return schema
}

const cell = async (id: string): Promise<Record<string, unknown>> => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id],
  )
  return JSON.parse(row.properties_json) as Record<string, unknown>
}

const rowContent = async (id: string): Promise<string> =>
  (await sharedDb.db.get<{content: string}>(
    'SELECT content FROM blocks WHERE id = ?', [id],
  )).content

const referenceTargetOf = async (id: string): Promise<string | null> =>
  (await sharedDb.db.get<{reference_target_id: string | null}>(
    'SELECT reference_target_id FROM blocks WHERE id = ?', [id],
  )).reference_target_id

const isLive = async (id: string): Promise<boolean> =>
  (await sharedDb.db.get<{deleted: number}>(
    'SELECT deleted FROM blocks WHERE id = ?', [id],
  )).deleted === 0

const liveFieldRow = async (blockId: string, fieldId: string): Promise<string | undefined> =>
  (await sharedDb.db.get<{id: string} | undefined>(
    'SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ? AND deleted = 0',
    [blockId, fieldId],
  ))?.id

const createHost = (repo: Repo, blockId: string): Promise<void> =>
  repo.tx(async tx => {
    await tx.create({
      id: blockId, workspaceId: WS, parentId: null, orderKey: `k-${blockId}`, content: 'host',
    })
  }, {scope: ChangeScope.BlockDefault})

/** Set `name` on a host block and return the field/value row ids it materialized. */
const seedProperty = async (
  repo: Repo, blockId: string, name: string, value: unknown, fieldId = FIELD_ID,
): Promise<{fieldRowId: string; valueRowId: string}> => {
  await createHost(repo, blockId)
  await repo.tx(tx => tx.setProperty(blockId, schemaFor(repo, name), value),
    {scope: ChangeScope.BlockDefault})
  const field = await sharedDb.db.get<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ? AND deleted = 0',
    [blockId, fieldId],
  )
  const valueRow = await sharedDb.db.get<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [field.id],
  )
  return {fieldRowId: field.id, valueRowId: valueRow.id}
}

/** A workspace with one live `status` definition at `FIELD_ID`.
 *
 *  @param codecType what the preset's codec reports, which is NOT the preset id
 *  — `optional-string` builds a codec of type `string`. Defaults to the preset
 *  id because the two coincide for `string` / `number` / `ref`, and every
 *  caller that needs a twin passes it. */
const makeRepo = (extensions?: readonly AnyValuePresetCore[]): Repo => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    ...(extensions
      ? {extensions: extensions.map(core => valuePresetCoresFacet.of(core, {source: 'test'}))}
      : {}),
  })
  repo.setActiveWorkspaceId(WS)
  return repo
}

const setupDefinition = async (
  presetId = 'string',
  extensions?: readonly AnyValuePresetCore[],
  codecType = presetId,
): Promise<Repo> => {
  const repo = makeRepo(extensions)
  await createDefinition(repo, FIELD_ID, 'status', presetId)
  await awaitDefinition(repo, 'status', codecType)
  return repo
}

const UNLOADABLE_PRESET = 'test-unloadable-preset'

/** A `status` definition on an EXTENSION's preset with one consumer holding
 *  `value`, reopened in a repo where that preset no longer builds — so the row
 *  is still published as metadata while carrying no codec.
 *
 *  The long way round on purpose. Re-typing a definition ONTO a preset that
 *  does not build is refused once it has consumers, so the only route left into
 *  the no-codec state is the one that has always been its real cause: the
 *  preset going missing UNDER a definition that was already using it. `was`
 *  chooses what the preset used to BE, which is what decides how many values
 *  the cell it left behind holds. Its `defaultValue` is per-case because
 *  `normalizePresetDefault` round-trips it through the codec — `''` under a
 *  list codec throws and collapses the schema to metadata-only. */
const withPresetUnloaded = async (
  value: unknown = 'done',
  was: {build: () => AnyCodec; defaultValue: unknown} =
    {build: () => codecs.string, defaultValue: ''},
): Promise<{repo: Repo; valueRowId: string}> => {
  const preset = {id: UNLOADABLE_PRESET, ...was} as unknown as AnyValuePresetCore
  const authoring = await setupDefinition(
    UNLOADABLE_PRESET, [preset], was.build().type)
  const {valueRowId} = await seedProperty(authoring, 'p', 'status', value)
  const repo = makeRepo()
  await vi.waitFor(() => {
    // BOTH halves are the precondition: a registry that is LIVE for this
    // workspace — otherwise an edit refuses as unjudgeable and a test would
    // pass on the wrong refusal — publishing a definition with no behaviour.
    if (repo.propertyDefinitions?.definitionsByName.get('status') === undefined) {
      throw new Error('[test] status definition not published yet')
    }
    if (repo.propertySchemas.get('status') !== undefined) {
      throw new Error('[test] status still has behaviour in the registry')
    }
  }, {timeout: 3000})
  return {repo, valueRowId}
}

const rename = (repo: Repo, fieldId: string, newName: string): Promise<void> =>
  repo.tx(tx => tx.setProperty(fieldId, propertyNameProp, newName),
    {scope: ChangeScope.BlockDefault})

const retype = (repo: Repo, fieldId: string, presetId: string): Promise<void> =>
  repo.tx(tx => tx.setProperty(fieldId, presetIdProp, presetId),
    {scope: ChangeScope.BlockDefault})

/** A refusal reaches this channel as well as the awaited promise: `repo.tx`
 *  notifies the listeners before it rethrows. */
const collectUserErrors = (repo: Repo): ProcessorRejection[] => {
  const errors: ProcessorRejection[] = []
  repo.onUserError(err => { errors.push(err) })
  return errors
}

/** Overwrite a value child's text directly — the shape a synced row has, and
 *  the only way to get value text the local codec would not have written. */
const setRawValueContent = (valueRowId: string, content: string): Promise<unknown> =>
  sharedDb.db.writeTransaction(async tx => {
    await tx.execute('UPDATE blocks SET content = ? WHERE id = ?', [content, valueRowId])
  })

describe('contestedChanges', () => {
  const change = (fieldId: string, oldName: string, newName: string) =>
    ({fieldId, oldName, newName})
  /** POST-COMMIT claims, which is what the refusal reads: `holding` is who
   *  still has the name after the tx, `arriving` is who newly has it. A rename
   *  appears in `arriving` under its destination and in NEITHER list under the
   *  name it leaves. */
  const claimants = (
    holding: Record<string, string[]>,
    arriving: Record<string, string[]> = {},
  ) => (name: string): NameClaim => ({
    holding: holding[name] ?? [],
    arriving: arriving[name] ?? [],
  })

  it('contests a rename onto a NEW name a different definition still holds', () => {
    expect(contestedChanges(
      [change('a', 'alpha', 'beta')],
      claimants({beta: ['b']}, {beta: ['a']}),
    )).toEqual([change('a', 'alpha', 'beta')])
  })

  it('contests a rename whose OLD name a different definition now answers to', () => {
    // `a` leaves `shared`, which un-shadows `b` — and `b` has no fan-out of its
    // own here, so the dropped key would strand its cell.
    expect(contestedChanges(
      [change('a', 'shared', 'alpha')],
      claimants({shared: ['b']}, {alpha: ['a']}),
    )).toEqual([change('a', 'shared', 'alpha')])
  })

  it('contests an IN-PLACE change when a peer arrives at the name it keeps', () => {
    // Nothing about the incumbent's own name moved, so only the arrival list
    // sees this. Which of the two the rebuilt registry picks decides whether
    // the re-encode lands under a name this definition still answers to, and
    // the transaction cannot see that ordering.
    expect(contestedChanges(
      [change('a', 'status', 'status')],
      claimants({status: ['a']}, {status: ['revived']}),
    )).toEqual([change('a', 'status', 'status')])
  })

  it('contests two renames converging on one previously unclaimed name', () => {
    const converging = [change('a', 'alpha', 'gamma'), change('b', 'beta', 'gamma')]
    expect(contestedChanges(converging, claimants({}, {gamma: ['a', 'b']})))
      .toEqual(converging)
  })

  it('contests a rename onto a name a definition REVIVED in the same tx will hold', () => {
    // The revived definition is absent from the tx-start registry and never
    // becomes a candidate — nothing about its own name changed — so only the
    // arrival list can see it. Its rank against the renamer is the rebuilt
    // registry's to decide, which may hand it cells the renamer wrote.
    expect(contestedChanges(
      [change('a', 'alpha', 'gamma')],
      claimants({}, {gamma: ['a', 'revived']}),
    )).toEqual([change('a', 'alpha', 'gamma')])
  })

  it('contests a rename whose VACATED name a definition arriving in this tx will hold', () => {
    // The mirror of the un-shadowing rule, and the arrival has no fan-out of
    // its own to project it under the name it inherits.
    expect(contestedChanges(
      [change('a', 'alpha', 'beta')],
      claimants({}, {beta: ['a'], alpha: ['revived']}),
    )).toEqual([change('a', 'alpha', 'beta')])
  })

  it('clears a swap — each inherits a name the other re-keys in the same tx', () => {
    expect(contestedChanges(
      [change('a', 'alpha', 'beta'), change('b', 'beta', 'alpha')],
      claimants({}, {beta: ['a'], alpha: ['b']}),
    )).toEqual([])
  })

  it('clears an uncontested rename, and a codec-only change that keeps its name', () => {
    expect(contestedChanges(
      [change('a', 'alpha', 'gamma'), change('b', 'beta', 'beta')],
      claimants({beta: ['b']}, {gamma: ['a']}),
    )).toEqual([])
  })

  it('judges each candidate on its own merits, not on whether a peer was contested', () => {
    // `b` moves `beta -> gamma` and IS contested, because `c` holds gamma. That
    // does not reach `a`: every candidate is judged against the state the tx
    // would commit, in which `beta` really is free. Deriving departures from
    // the surviving set instead made one contested candidate cascade into the
    // next. (The transaction is refused over `b` regardless — what must not
    // happen is `a` being judged contested on its own.)
    expect(contestedChanges(
      [change('a', 'alpha', 'beta'), change('b', 'beta', 'gamma')],
      claimants({gamma: ['c']}, {beta: ['a'], gamma: ['b']}),
    )).toEqual([change('b', 'beta', 'gamma')])
  })

  // `null` is "nothing here can be judged", not "nobody claims this name" — the
  // permissive reading would approve a rename onto a seed-owned key in a
  // workspace with no registry snapshot. Split per NAME because either clause
  // alone contests the candidate, so a single test with both unknown leaves
  // whichever one is deleted covered by the other.
  it('contests a rename whose DESTINATION cannot be judged', () => {
    expect(contestedChanges(
      [change('a', 'alpha', 'beta')],
      (name) => name === 'beta' ? null : {holding: [], arriving: []},
    )).toEqual([change('a', 'alpha', 'beta')])
  })

  it('contests a rename whose VACATED name cannot be judged', () => {
    expect(contestedChanges(
      [change('a', 'alpha', 'beta')],
      (name) => name === 'alpha' ? null : {holding: [], arriving: []},
    )).toEqual([change('a', 'alpha', 'beta')])
  })
})

describe('consumingParentIds', () => {
  it('unions parents across chunks instead of re-visiting one twice', async () => {
    // SELECT DISTINCT dedupes only WITHIN a statement, so a parent consuming
    // two changed definitions that land in different chunks comes back once per
    // chunk — and re-keying it twice is what the Set exists to prevent.
    const calls: unknown[][] = []
    const db = {
      getAll: async <T,>(_sql: string, params?: unknown[]): Promise<T[]> => {
        calls.push(params ?? [])
        return [{parent_id: 'shared'}] as T[]
      },
    }

    expect(await consumingParentIds(db, WS, ['f1', 'f2'], 1)).toEqual(['shared'])
    expect(calls).toHaveLength(2)
    expect(calls.map(params => params[1])).toEqual(['f1', 'f2'])
  })
})

describe('rename', () => {
  it('re-keys consuming cells; field-row content is id-stable across the rename', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'status', 'done')
    expect(await cell('p')).toEqual({status: 'done'})

    await rename(repo, FIELD_ID, 'state')

    // Field rows address the definition BY ID (`::((fieldId))`, §7), so a rename
    // never retitles their content — only the name-keyed cell re-keys.
    expect(await rowContent(fieldRowId)).toBe(`::((${FIELD_ID}))`)
    expect(await cell('p')).toEqual({state: 'done'})
    expect(await rowContent(valueRowId)).toBe('done')
  })

  it('is dormant when the definition has no field rows', async () => {
    await seedWorkspace('cell')
    const repo = await setupDefinition()
    await createHost(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', schemaFor(repo, 'status'), 'done'),
      {scope: ChangeScope.BlockDefault})

    await rename(repo, FIELD_ID, 'state')

    // An un-flipped workspace writes no children, so the consumer probe finds
    // nothing and the cell keeps the old key — today's rename semantics. The
    // probe is what makes this so, NOT the workspace's migration flag; see the
    // stale-flag test below for why that distinction is load-bearing.
    expect(await cell('p')).toEqual({status: 'done'})
  })

  it('follows the field rows, not a workspace flag this device may be stale on', async () => {
    // `properties_migration` lives on the workspace ROW and syncs like any
    // other. A device lagging on it reads `cell` for a graph another device
    // already flipped and materialized — and gating on it there would skip a
    // fan-out whose field rows this device is holding, then upload a re-typed
    // definition its child-backed peers read old encodings through.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')
    await sharedDb.db.writeTransaction(async tx => {
      await tx.execute(
        'UPDATE workspaces SET properties_migration = ? WHERE id = ?', ['cell', WS],
      )
    })

    await retype(repo, FIELD_ID, 'number')

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('does NOT tombstone the field row or value child', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'status', 'done')

    await rename(repo, FIELD_ID, 'state')

    // The trap the processor's header documents: the tx-start registry still
    // maps the OLD name -> this definition, so if MATERIALIZE re-saw the
    // re-keyed cell (old key dropped) it would read that as a user delete and
    // tombstone these very rows. The processor runs LAST in
    // KERNEL_SAME_TX_PROCESSORS to dodge it — assert the rows survived.
    expect(await isLive(fieldRowId), fieldRowId).toBe(true)
    expect(await isLive(valueRowId), valueRowId).toBe(true)
  })

  it('leaves value text alone on a rename, even when it is stale', async () => {
    // A rename does not change the codec, so a value the codec would write
    // differently is the user's text, not a conversion candidate: re-encoding
    // it here would normalize `1.50` to `1.5` behind their back, and an
    // unparseable one is pre-existing staleness, not "could not convert to the
    // new type". Both were the deferred batch's behavior, and both were wrong
    // (#800 item 2).
    await seedWorkspace('children')
    const repo = await setupDefinition('number')
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 42)
    const {valueRowId: staleRowId} = await seedProperty(repo, 'q', 'status', 7)
    await setRawValueContent(valueRowId, '1.50')
    await setRawValueContent(staleRowId, 'not a number')

    await rename(repo, FIELD_ID, 'state')
    await repo.awaitProcessors()

    expect(await rowContent(valueRowId)).toBe('1.50')
    expect(await rowContent(staleRowId)).toBe('not a number')
  })

  it('skips a soft-deleted consumer instead of failing the whole edit', async () => {
    // A tombstoned parent keeps its live field rows, so the consumer query
    // still returns it — and `tx.update` on a tombstone throws, which would
    // roll the user's rename back over a block they already deleted.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await seedProperty(repo, 'gone', 'status', 'done')
    await repo.tx(tx => tx.delete('gone'), {scope: ChangeScope.BlockDefault})

    await rename(repo, FIELD_ID, 'state')

    expect(await cell('p')).toEqual({state: 'done'})
    expect(await cell('gone')).toEqual({status: 'done'})
  })

  it('is ONE undoable step', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')

    await rename(repo, FIELD_ID, 'state')
    expect(await cell('p')).toEqual({state: 'done'})

    await repo.undo(ChangeScope.BlockDefault)

    // Both halves — the definition block's own name AND the consuming cell's
    // re-key — revert together, in the one undo step.
    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
    expect(await cell('p')).toEqual({status: 'done'})
  })
})

describe('codec change', () => {
  it('re-encodes convertible values canonically and reprojects the cell', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')

    await retype(repo, FIELD_ID, 'number')

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('is ONE undoable step with the definition edit', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')

    await retype(repo, FIELD_ID, 'number')
    expect(await cell('p')).toEqual({status: 42})

    await repo.undo(ChangeScope.BlockDefault)

    // The whole point of #1013: the re-encode rides the user's own tx, so cmd-Z
    // takes the preset, the cell and the re-encoded child back together. The
    // deferred pass could not do this — its writes were a separate,
    // non-undoable tx, which is why it had to CLEAR the undo stack.
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string')
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await rowContent(valueRowId)).toBe(' 42 ')
  })

  it('REFUSES a re-type that would take a value away, and leaves the graph untouched', async () => {
    // Refusal, not report-and-commit: a committed report leaves the cell
    // holding what the OLD codec projected until something reprojects it
    // (#1024). Everything below is the pre-edit state, down to the definition
    // row.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'status', 'not a number')

    await expect(retype(repo, FIELD_ID, 'number')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      meta: {name: 'status', count: 1},
    })
    await repo.awaitProcessors()

    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string')
    expect(await cell('p')).toEqual({status: 'not a number'})
    expect(await rowContent(valueRowId)).toBe('not a number')
    expect(await isLive(fieldRowId), fieldRowId).toBe(true)
    expect(await isLive(valueRowId), valueRowId).toBe(true)
  })

  it('counts every lost value across every consumer, not just the first', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'not a number')
    await seedProperty(repo, 'q', 'status', 'also not a number')

    // Summed over consumers — a per-parent early exit would tell the user to
    // fix one block and leave them to rediscover the rest one refusal at a
    // time.
    await expect(retype(repo, FIELD_ID, 'number')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      meta: {count: 2},
    })
  })

  it('does NOT refuse over a value that was already unreadable before the edit', async () => {
    // A hand-broken value row is not in the cell and has not been for as long
    // as it has been broken — the projection could not read it either. A
    // refusal over it would block every later change to the definition on a row
    // this edit neither takes away nor repairs, so it is left exactly as stored
    // and the convertible value re-encodes around it.
    await seedWorkspace('children')
    const repo = await setupDefinition('number')
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'status', 7)
    await setRawValueContent(valueRowId, 'not a number')
    expect(await cell('p')).toEqual({status: 7})

    await retype(repo, FIELD_ID, 'boolean')
    await repo.awaitProcessors()

    // §9's default-value rule: a live field row with nothing parseable under it
    // reads as unset, which is what the projection has been saying about this
    // row since it arrived.
    expect(await cell('p')).toEqual({})
    expect(await rowContent(valueRowId)).toBe('not a number')
    expect(await isLive(fieldRowId), fieldRowId).toBe(true)
    expect(await isLive(valueRowId), valueRowId).toBe(true)
  })

  it('leaves a value that already reads as the new type alone', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', '42')

    await retype(repo, FIELD_ID, 'number')
    await repo.awaitProcessors()

    expect(await rowContent(valueRowId)).toBe('42')
    expect(await cell('p')).toEqual({status: 42})
  })

  it('re-encodes on the tx that REPAIRS a definition with no buildable codec', async () => {
    // A preset that cannot build leaves the definition behaviour-less: the
    // registry publishes metadata only, and nothing on this device can say what
    // codec its stored values are in. Repairing it to a working preset is the
    // only moment the re-encode can happen, and the old codec is not needed to
    // do it — the conversion parses the child's TEXT under the new one.
    await seedWorkspace('children')
    const {repo, valueRowId} = await withPresetUnloaded(' 42 ')

    await retype(repo, FIELD_ID, 'number')

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('canonicalizes a tolerant spelling where the OLD codec normalizes', async () => {
    // `date` decode CANONICALIZES a tolerant instant, so carrying the value
    // rewrites the row text: the cell survives, and the spelling a person
    // typed does not — here, unrecoverably.
    await seedWorkspace('children')
    const repo = await setupDefinition('date')
    const {valueRowId} = await seedProperty(
      repo, 'p', 'status', new Date('2024-01-02T00:00:00.000Z'))
    // Raw, because a tolerant spelling is what a synced or hand-edited row
    // carries — the local writer would have canonicalized it on the way in.
    await setRawValueContent(valueRowId, '2024-01-02')
    expect(await cell('p')).toEqual({status: '2024-01-02T00:00:00.000Z'})

    await retype(repo, FIELD_ID, 'string')
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: '2024-01-02T00:00:00.000Z'})
    expect(await rowContent(valueRowId)).toBe('2024-01-02T00:00:00.000Z')
  })

  it('does NOT refuse a repair over a SCALAR cell that happens to hold an array', async () => {
    // The cell cannot say the property's arity. An identity codec holds an
    // array as ONE value in ONE row, so reading the cell's length as a member
    // count refused a repair that republishes the cell byte-identical — and
    // the same data with the old codec available commits, which is the
    // contradiction that gives it away.
    await seedWorkspace('children')
    const {repo} = await withPresetUnloaded(
      [1, 2, 3], {build: () => codecs.unsafeIdentity<unknown>(), defaultValue: null})
    expect(await cell('p')).toEqual({status: [1, 2, 3]})

    await retype(repo, FIELD_ID, 'json')
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: [1, 2, 3]})
  })

  it('KEEPS a bare `null` a repair cannot classify, refusing rather than deleting it', async () => {
    // The cleared sentinel and a real JSON null are the same bytes, and with
    // the preset gone nothing can say which this is. Counted as a value: the
    // cost is refusing a repair over a genuinely cleared one (#1077), and the
    // alternative cost is deleting a real one.
    await seedWorkspace('children')
    const {repo} = await withPresetUnloaded(
      null, {build: () => codecs.unsafeIdentity<unknown>(), defaultValue: null})
    expect(await cell('p')).toEqual({status: null})

    await expect(retype(repo, FIELD_ID, 'number')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
    })
    expect(await cell('p')).toEqual({status: null})
  })

  it('ACCEPTS a narrowing with no old codec, losing members silently (#1090)', async () => {
    // Pinned as an accepted weakness, not as a good answer. With no codec the
    // only records of what the property held — the cell's length and the row
    // count — are both UPPER bounds, and a loss count built from those refuses
    // repairs that lose nothing. So a loss is claimed only where the
    // projection comes out EMPTY, which misses this one. #1077 is the fix:
    // rebuild the children FROM the cell, and the counting problem goes away.
    await seedWorkspace('children')
    const {repo} = await withPresetUnloaded(
      ['1', '2', '3'], {build: () => codecs.list(codecs.string), defaultValue: []})
    expect(await cell('p')).toEqual({status: ['1', '2', '3']})

    await retype(repo, FIELD_ID, 'number')
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: 1})
  })

  it('REFUSES when the projection comes out empty over a cell that held a value', async () => {
    // The one loss the no-codec branch can still see, and the reason it is not
    // simply `return 0`: the row is unreadable under the new codec, so the
    // projection is empty while the cell plainly holds something. Committing
    // on that answer unsets a populated key, and nothing follows this pass to
    // notice.
    await seedWorkspace('children')
    const {repo} = await withPresetUnloaded('prose value')

    await expect(retype(repo, FIELD_ID, 'number')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
    })
    expect(await cell('p')).toEqual({status: 'prose value'})
  })

  it('re-stamps the reference columns when a ref value becomes plain text', async () => {
    // Retyping a ref property rewrites `((id))` into the bare id AFTER
    // `core.deriveReferenceTarget` ran, and this processor's writes are
    // settled, so the derive re-run never revisits the row. Without an inline
    // re-stamp the column keeps naming a target the content no longer
    // references.
    await seedWorkspace('children')
    const repo = await setupDefinition('ref')
    await createHost(repo, 'target')
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 'target')
    expect(await referenceTargetOf(valueRowId)).toBe('target')

    await retype(repo, FIELD_ID, 'string')

    expect(await rowContent(valueRowId)).toBe('target')
    expect(await referenceTargetOf(valueRowId)).toBeNull()
  })

  it('REFUSES a re-type onto a preset whose build throws, rather than aborting raw', async () => {
    // `preset.build` is extension code, and a THROW is not the same as a
    // missing preset: `tryBuildSchema` answers null for one and lets the other
    // escape. An escape would abort the user's transaction with whatever the
    // extension threw; caught, it is the same answer as null and the user gets
    // the refusal that names what to do.
    const throwing = {
      id: 'test-throwing-preset',
      build: () => { throw new Error('[test] preset build failed') },
      defaultValue: '',
    } as unknown as AnyValuePresetCore
    await seedWorkspace('children')
    const repo = await setupDefinition('string', [throwing])
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')

    await expect(retype(repo, FIELD_ID, throwing.id)).rejects.toMatchObject({
      code: 'property.definition-change.unbuildable',
    })
    expect(await rowContent(valueRowId)).toBe(' 42 ')
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string')
  })


  it('treats a switch between presets sharing a codec TYPE as an encoding change', async () => {
    // An optional preset and its required twin report the SAME `codec.type`
    // while storing an unset value differently — `optional-number` writes
    // `null`, which the required `number` cannot parse at all. Keying the
    // decision off the type string calls this switch a no-op, so the stranded
    // cell is never re-projected and the stale value stands.
    await seedWorkspace('children')
    const repo = await setupDefinition('optional-number', undefined, 'number')
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 7)
    await setRawValueContent(valueRowId, 'null')
    expect(await cell('p')).toEqual({status: 7})

    await retype(repo, FIELD_ID, 'number')
    await repo.awaitProcessors()

    // The cell moving AT ALL is what pins detection: a switch read as a no-op
    // leaves the stale `7` standing.
    expect(await cell('p')).toEqual({})
    expect(await rowContent(valueRowId)).toBe('null')
  })

  it('does not refuse a narrowing over a value the user CLEARED', async () => {
    // `null` under a null-accepting codec is the encoded form of unset, not a
    // value — `optionalNumber.encode(undefined)` writes exactly this. Counting
    // it as one would refuse every optional -> required narrowing on every
    // block that ever cleared the property, with a message naming a value
    // there is none of.
    await seedWorkspace('children')
    const repo = await setupDefinition('optional-number', undefined, 'number')
    const schema = schemaFor(repo, 'status')
    await createHost(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', schema, undefined),
      {scope: ChangeScope.BlockDefault})

    await retype(repo, FIELD_ID, 'number')
    await repo.awaitProcessors()

    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('number')
  })

  it('REFUSES a re-type it cannot read the old values with at all', async () => {
    // A definition whose preset does not build is the one case where the cell
    // is the only record: PROJECT skips the key for want of a schema, so the
    // cell keeps what the preset published while it still loaded, and reading
    // the children answers "no values" about a cell plainly holding one.
    // Treating that as "nothing was there" committed the re-type and emptied
    // the cell silently — strictly worse than the report it replaced.
    await seedWorkspace('children')
    const {repo, valueRowId} = await withPresetUnloaded('prose value')
    expect(await cell('p')).toEqual({status: 'prose value'})

    await expect(retype(repo, FIELD_ID, 'number')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      meta: {name: 'status', count: 1},
    })
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: 'prose value'})
    expect(await rowContent(valueRowId)).toBe('prose value')
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe(UNLOADABLE_PRESET)
  })

  it('does not refuse over a divergent PEER row the cell never projected', async () => {
    // Two value children under one scalar field row are a surfaced conflict
    // (§9): the projection reads the first that parses and the other is not in
    // the cell. Refusing over it asks the user to go fix a row that costs them
    // nothing, and the message could not even name it.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {fieldRowId} = await seedProperty(repo, 'p', 'status', '42')
    const peer = 'peer-value-row'
    await sharedDb.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
         properties_json, deleted, created_at, updated_at, user_updated_at,
         created_by, updated_by)
       VALUES (?, ?, ?, 'zz', 'prose', '{}', 0, 1, 1, 1, 'user-1', 'user-1')`,
      [peer, WS, fieldRowId])
    expect(await cell('p')).toEqual({status: '42'})

    await retype(repo, FIELD_ID, 'number')
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(peer)).toBe('prose')
    expect(await isLive(peer), peer).toBe(true)
  })

  it('refuses the SAME edit when it renames AND switches to a preset that cannot build', async () => {
    // Re-keying under the BEFORE row's codec and letting it commit was the
    // earlier answer, and it leaves the definition naming a codec nothing built
    // over values in the old one — with no transaction left in which to
    // reconcile them, because the preset can arrive without one. Refusing keeps
    // the rename and the fan-out together: neither half lands.
    await seedWorkspace('children')
    const repo = await setupDefinition('number')
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 42)
    const errors = collectUserErrors(repo)

    await expect(repo.tx(async tx => {
      await tx.setProperty(FIELD_ID, propertyNameProp, 'state')
      await tx.setProperty(FIELD_ID, presetIdProp, 'no-such-preset')
    }, {scope: ChangeScope.BlockDefault})).rejects.toMatchObject({
      code: 'property.definition-change.unbuildable',
    })
    await repo.awaitProcessors()

    // Rolled back whole: the definition row did not land either.
    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('number')
    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
    // Only the refusal reaches the user — no "could not convert to the new
    // type" beside it, which would be a lie about an edit that did not land.
    expect(errors.map(error => error.code))
      .toEqual(['property.definition-change.unbuildable'])
  })

  it('re-encodes when CONFIG changes the built codec under one preset id', async () => {
    // An extension preset may build a different codec from its config. The
    // preset id does not move, so only the built codec's type reports it.
    const configurable = {
      id: 'test-configurable-preset',
      configCodec: {
        type: 'test-config',
        encode: (c: unknown) => c,
        decode: (j: unknown) => j ?? {as: 'string'},
      },
      // Absence-aware pair: `defaultValue: undefined` normalizes under BOTH,
      // which a required string/number pair has no value that does — and a
      // preset whose default cannot build is a different bug than this one.
      build: (config: {as?: string} | undefined) =>
        config?.as === 'number' ? codecs.optionalNumber : codecs.optionalString,
      defaultValue: undefined,
    } as unknown as AnyValuePresetCore

    await seedWorkspace('children')
    const repo = await setupDefinition(configurable.id, [configurable], 'string')
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')

    await repo.tx(tx => tx.setProperty(FIELD_ID, presetConfigProp, {as: 'number'}),
      {scope: ChangeScope.BlockDefault})

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('re-encodes a config change between codecs that SHARE a type', async () => {
    // `optional-string` and `string` report the same `codec.type`, and the
    // preset id does not move either — so only the codec's INPUTS can see this.
    const configurable = {
      id: 'test-optionality-preset',
      configCodec: {
        type: 'test-config',
        encode: (c: unknown) => c,
        decode: (j: unknown) => j ?? {},
      },
      build: (config: {required?: boolean} | undefined) =>
        config?.required === true ? codecs.string : codecs.optionalString,
      defaultValue: '',
    } as unknown as AnyValuePresetCore

    await seedWorkspace('children')
    const repo = await setupDefinition(configurable.id, [configurable], 'string')
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 'done')
    // `null` is what the optional codec writes for unset; the required one reads
    // the same text as the literal string. The cell still says `done` until
    // something reprojects it from the child.
    await setRawValueContent(valueRowId, 'null')
    expect(await cell('p')).toEqual({status: 'done'})

    await repo.tx(tx => tx.setProperty(FIELD_ID, presetConfigProp, {required: true}),
      {scope: ChangeScope.BlockDefault})

    // Reprojected under the new config, which only happens if the switch was
    // recognized at all — neither the preset id nor `codec.type` moved.
    expect(await cell('p')).toEqual({status: 'null'})
  })

  describe('narrowing a Choice option set (#1080/#1088)', () => {
    // The question this answers: now that an off-menu value is refused on the
    // way in, what does REMOVING an option that blocks still use actually do?
    // Not a silent mass unset — a config edit is a codec-inputs change, so it
    // fans out, and the fan-out refuses rather than writing. Asserted rather
    // than reasoned, because the alternative reading (every using block loses
    // its value) is the one the fix would be unacceptable under.
    const options = (...values: readonly string[]) =>
      ({options: values.map(value => ({value, label: value}))})

    /** Fence on the OPTION SET, not on the codec type. The definition is
     *  created with preset `enum` and the default empty config, so
     *  `awaitDefinition(..., 'enum')` is already satisfied before the config
     *  write projects — under load the seed below then encodes against
     *  `enum()` and throws, which is how this first reached CI. Ask the
     *  registry the question the test depends on: does this codec accept the
     *  value we are about to store? */
    const awaitOptions = (repo: Repo, ...values: readonly string[]) =>
      vi.waitFor(() => {
        const codec = schemaFor(repo, 'status').codec
        for (const value of values) codec.encode(value)
      }, {timeout: 3000})

    const setupChoice = async (...values: readonly string[]) => {
      await seedWorkspace('children')
      const repo = await setupDefinition('enum', undefined, 'enum')
      await repo.tx(tx => tx.setProperty(FIELD_ID, presetConfigProp, options(...values)),
        {scope: ChangeScope.BlockDefault})
      await awaitOptions(repo, ...values)
      return repo
    }

    it('REFUSES to remove an option while blocks still hold it, keeping the value', async () => {
      const repo = await setupChoice('low', 'high')
      const {valueRowId} = await seedProperty(repo, 'p', 'status', 'high')
      expect(await cell('p')).toEqual({status: 'high'})

      await expect(
        repo.tx(tx => tx.setProperty(FIELD_ID, presetConfigProp, options('low')),
          {scope: ChangeScope.BlockDefault}),
      ).rejects.toMatchObject({code: 'property.definition-change.unconvertible'})

      // Rolled back whole: the value, its row, and the option set itself.
      expect(await cell('p')).toEqual({status: 'high'})
      expect(await rowContent(valueRowId)).toBe('high')
      expect((await cell(FIELD_ID))[presetConfigProp.name]).toEqual(options('low', 'high'))
    })

    it('allows removing an option no block holds', async () => {
      const repo = await setupChoice('low', 'high')
      await seedProperty(repo, 'p', 'status', 'low')

      await repo.tx(tx => tx.setProperty(FIELD_ID, presetConfigProp, options('low')),
        {scope: ChangeScope.BlockDefault})
      await repo.awaitProcessors()

      expect(await cell('p')).toEqual({status: 'low'})
    })

    it('writes no value row when ADDING an option to rows in the LEGACY spelling', async () => {
      // The case the test below cannot reach, because it seeds through the
      // current writer. A child written before #1080 holds `"high"`, which the
      // new codec still reads — so canonicalizing it would rewrite every
      // consuming row for an edit that changes no value, in the user's own tx
      // and straight up to sync. The value route keeps text that already reads
      // back as the value it holds.
      const repo = await setupChoice('low', 'high')
      const {valueRowId} = await seedProperty(repo, 'p', 'status', 'high')
      await setRawValueContent(valueRowId, '"high"')
      await sharedDb.db.execute('UPDATE blocks SET updated_at = 0 WHERE id = ?', [valueRowId])

      await repo.tx(tx => tx.setProperty(FIELD_ID, presetConfigProp, options('low', 'high', 'urgent')),
        {scope: ChangeScope.BlockDefault})
      await repo.awaitProcessors()

      const after = await sharedDb.db.get<{updated_at: number}>(
        'SELECT updated_at FROM blocks WHERE id = ?', [valueRowId])
      expect(after.updated_at).toBe(0)
      expect(await rowContent(valueRowId)).toBe('"high"')
      expect(await cell('p')).toEqual({status: 'high'})
    })

    it('writes no value row when ADDING an option, since no spelling moves', async () => {
      // Widening is a codec-inputs change too, so the fan-out runs over every
      // consuming parent. It must not turn into a write per block: the
      // spelling is identical, and the processor skips a row whose converted
      // content equals its current content.
      const repo = await setupChoice('low', 'high')
      const {valueRowId} = await seedProperty(repo, 'p', 'status', 'high')
      // `updated_at`, stamped to a SENTINEL, and not `user_updated_at`: the
      // fan-out writes with `{skipMetadata: true}`, which deliberately leaves
      // the user-facing stamp alone, so a redundant same-content rewrite is
      // invisible there. `metadataPatch` still returns a fresh `updatedAt` on
      // that path, so any write at all replaces the sentinel — and a sentinel
      // rather than a captured value because a fast test stamps both in the
      // same millisecond.
      await sharedDb.db.execute('UPDATE blocks SET updated_at = 0 WHERE id = ?', [valueRowId])

      await repo.tx(tx => tx.setProperty(FIELD_ID, presetConfigProp, options('low', 'high', 'urgent')),
        {scope: ChangeScope.BlockDefault})
      await repo.awaitProcessors()

      const after = await sharedDb.db.get<{updated_at: number}>(
        'SELECT updated_at FROM blocks WHERE id = ?', [valueRowId])
      expect(after.updated_at).toBe(0)
      expect(await rowContent(valueRowId)).toBe('high')
      expect(await cell('p')).toEqual({status: 'high'})
    })
  })

  it('refuses an in-place RE-TYPE off a preset that loads, when consumers exist', async () => {
    // The values stay in the old encoding while the row names a codec nothing
    // can build. Dropping the edit silently is the trap: the preset can become
    // available later with no definition-row transaction at all — an extension
    // registering — and the registry then publishes it straight over them.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')

    await expect(retype(repo, FIELD_ID, 'no-such-preset')).rejects.toMatchObject({
      code: 'property.definition-change.unbuildable',
    })
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string')
    expect(await cell('p')).toEqual({status: 'done'})
  })

  it('leaves an unrelated bag write on an unbuildable definition alone', async () => {
    // Every write to a definition block's bag reaches this processor —
    // MATERIALIZE's own field-row bookkeeping included. The no-change guard has
    // to come BEFORE the unbuildable hold, or each of those writes refuses the
    // transaction for a definition whose preset merely is not loaded, which is
    // most of a session for a workspace missing an extension.
    await seedWorkspace('children')
    const {repo} = await withPresetUnloaded()

    await repo.tx(async tx => {
      const definition = await tx.get(FIELD_ID)
      await tx.update(FIELD_ID, {
        properties: {...definition!.properties, 'test:unrelated': 'note'},
      })
    }, {scope: ChangeScope.BlockDefault})

    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe(UNLOADABLE_PRESET)
    expect(await cell('p')).toEqual({status: 'done'})
  })

  it('refuses a rename when NEITHER row builds a codec and consumers exist', async () => {
    // Nothing can reproject the cell, and the transaction that eventually
    // repairs the preset cannot drop the old key either — by then both sides
    // carry the new name. Refusing keeps the two halves together.
    await seedWorkspace('children')
    const {repo} = await withPresetUnloaded()

    await expect(rename(repo, FIELD_ID, 'state')).rejects.toMatchObject({
      code: 'property.definition-change.unbuildable',
    })
    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
    expect(await cell('p')).toEqual({status: 'done'})
  })

  it('refuses a RE-TYPE between two presets that BOTH fail to build', async () => {
    // The row is the only durable record of what encoding its consumers are in,
    // and it is that record whether or not the preset it names loads today.
    // Trading one unavailable preset for another overwrites it, so whichever of
    // the two eventually registers, its codec is published over values nothing
    // re-encoded.
    await seedWorkspace('children')
    const {repo} = await withPresetUnloaded()

    await expect(retype(repo, FIELD_ID, 'another-missing-preset')).rejects.toMatchObject({
      code: 'property.definition-change.unbuildable',
    })
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe(UNLOADABLE_PRESET)
  })

  it('still allows that re-type when the definition has no consumers', async () => {
    // Nothing to strand, so the refusal would be friction for nothing — and
    // this is the path a user takes to point a definition at a preset whose
    // extension has not loaded yet.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await retype(repo, FIELD_ID, 'no-such-preset')

    await retype(repo, FIELD_ID, 'another-missing-preset')

    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('another-missing-preset')
  })

  it('allows that rename when the definition has no consumers', async () => {
    // Friction for nothing otherwise: there is no cell to strand.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await retype(repo, FIELD_ID, 'no-such-preset')
    await vi.waitFor(() => {
      if (repo.propertySchemas.get('status') !== undefined) {
        throw new Error('[test] status still has behaviour in the registry')
      }
    }, {timeout: 3000})

    await rename(repo, FIELD_ID, 'state')

    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('state')
  })

  it('rename + re-type in ONE edit re-keys AND re-encodes together', async () => {
    // Both triggers in one tx: `status` (string) becomes `state` (number). The
    // field row's content is id-addressed and rename-stable, so only the
    // name-keyed cell moves and the value child's TEXT is re-spelled under the
    // new codec.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')

    await repo.tx(async tx => {
      await tx.setProperty(FIELD_ID, propertyNameProp, 'state')
      await tx.setProperty(FIELD_ID, presetIdProp, 'number')
    }, {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({state: 42})
    expect(await rowContent(valueRowId)).toBe('42')
    expect(await rowContent(fieldRowId)).toBe(`::((${FIELD_ID}))`)
    expect(await isLive(fieldRowId), fieldRowId).toBe(true)
  })

  it('refuses a rename + re-type whose value does not convert, keeping BOTH halves', async () => {
    // The rename is the half that would strand the consumer worst: it drops the
    // old key, so committing it without a value to publish under the new name
    // loses the property outright. Neither half lands.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 'not a number')

    await expect(repo.tx(async tx => {
      await tx.setProperty(FIELD_ID, propertyNameProp, 'state')
      await tx.setProperty(FIELD_ID, presetIdProp, 'number')
    }, {scope: ChangeScope.BlockDefault})).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      // The name it still ANSWERS TO after the rollback, not the one this tx
      // tried to give it — the user has no property called `state` to go fix.
      meta: {name: 'status', count: 1},
    })
    await repo.awaitProcessors()

    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
    expect(await cell('p')).toEqual({status: 'not a number'})
    expect(await rowContent(valueRowId)).toBe('not a number')
  })
})

describe('a workspace this client cannot judge', () => {
  it('refuses the edit rather than committing it without its fan-out', async () => {
    // Editing a definition in a workspace that is no longer active: the claim
    // lookup answers nothing, which is not a verdict that its names are free —
    // it means the fan-out cannot run at all. Committing the definition row
    // alone would leave every consumer in the old encoding with nothing left to
    // repair them, so the whole tx is refused.
    await seedWorkspace('children')
    await seedWorkspace('children', 'ws-elsewhere')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    const errors = collectUserErrors(repo)

    // ONE switch is enough: name ownership is only judged against the ACTIVE
    // workspace's registry, because the retained previous snapshot is frozen
    // the moment the projector disposes its subscription.
    repo.setActiveWorkspaceId('ws-elsewhere')
    await vi.waitFor(() => {
      if (repo.propertyDefinitions?.workspaceId === WS) {
        throw new Error('[test] the registry has not moved off the definition\'s workspace')
      }
    }, {timeout: 3000})
    await expect(rename(repo, FIELD_ID, 'state')).rejects.toMatchObject({
      code: 'property.definition-change.unjudgeable',
    })

    // Neither half landed: the definition keeps its name and the consumer its key.
    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
    expect(await cell('p')).toEqual({status: 'done'})
    expect(errors.map(e => e.code)).toEqual(['property.definition-change.unjudgeable'])
  })
})

describe('claimants the batch itself adds or removes', () => {
  const FIELD_PEER = 'field-peer-change'

  it('lets an in-place change through while a SHADOWED peer shares its name', async () => {
    // Two live definitions under one name is a modelled state, and the head
    // claimant keeps projecting it. A change that KEEPS its name vacates
    // nothing, so the peer is the status quo rather than something this edit
    // creates — judging it against the vacated half instead would refuse every
    // re-type in a shadowed workspace, which is the state sync produces.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')
    await createDefinition(repo, FIELD_PEER, 'status', 'string')
    // The precondition IS the test: both rows must claim `status` at tx start,
    // with this one the head, or the clause under test is never reached.
    await vi.waitFor(() => {
      const snapshot = repo.propertyDefinitions
      if (snapshot === undefined || snapshot === null) {
        throw new Error('[test] no registry yet')
      }
      const claimants = propertyDefinitionClaimantsForName(snapshot, 'status')
      if (claimants.length !== 2) {
        throw new Error(`[test] status has ${claimants.length} claimant(s), want 2`)
      }
      if (claimants[0] !== FIELD_ID) {
        throw new Error(`[test] head claimant is ${claimants[0]}, want ${FIELD_ID}`)
      }
    }, {timeout: 3000})

    await retype(repo, FIELD_ID, 'number')

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('refuses a rename onto the name of a definition RESTORED in the same tx', async () => {
    // `tx.restore` flips `deleted` and rewrites an identical properties bag, and
    // the field watch compares by value — so a properties-only watch never sees
    // the revived claimant at all, and the rename lands on a key the rebuilt
    // registry may award to it.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await createDefinition(repo, FIELD_PEER, 'archived', 'string')
    await awaitDefinition(repo, 'archived', 'string')
    await repo.tx(tx => tx.delete(FIELD_PEER), {scope: ChangeScope.BlockDefault})

    await expect(repo.tx(async tx => {
      await tx.restore(FIELD_PEER)
      await tx.setProperty(FIELD_ID, propertyNameProp, 'archived')
    }, {scope: ChangeScope.BlockDefault})).rejects.toMatchObject({
      code: 'property.definition-change.contested',
    })

    // Rolled back WHOLE (#1028). Committing the rename and skipping its fan-out
    // left the consumer keyed under a name its definition no longer answered
    // to — the mass silent unset this pass exists to prevent, arriving by the
    // other door.
    expect(await cell('p')).toEqual({status: 'done'})
    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
    expect(await isLive(FIELD_PEER)).toBe(false)
  })

  it('lets a rename through onto a name an UNBUILDABLE rename vacates', async () => {
    // The unused definition's rename is allowed (no consumers to strand) but it
    // is not a candidate, so it cannot reach `vacating` — and it would contest
    // the name it is about to leave, dropping the other fan-out while both
    // definition rows committed anyway.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await createDefinition(repo, FIELD_PEER, 'archived', 'string')
    await awaitDefinition(repo, 'archived', 'string')
    await retype(repo, FIELD_PEER, 'no-such-preset')
    await vi.waitFor(() => {
      if (repo.propertySchemas.get('archived') !== undefined) {
        throw new Error('[test] the peer still has behaviour in the registry')
      }
    }, {timeout: 3000})

    await repo.tx(async tx => {
      await tx.setProperty(FIELD_PEER, propertyNameProp, 'retired')
      await tx.setProperty(FIELD_ID, propertyNameProp, 'archived')
    }, {scope: ChangeScope.BlockDefault})

    expect(await cell('p')).toEqual({archived: 'done'})
  })

  it('refuses an in-place RE-TYPE when a definition is restored under its name', async () => {
    // The incumbent is still the tx-start head, so the owner test passes — but
    // the restored definition is not a candidate, nothing refuses it, and it may
    // outrank the incumbent once the registry rebuilds, at which point it reads
    // the value the incumbent just re-encoded as its own under another codec.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')
    await createDefinition(repo, FIELD_PEER, 'status', 'string')
    await repo.tx(tx => tx.delete(FIELD_PEER), {scope: ChangeScope.BlockDefault})

    await expect(repo.tx(async tx => {
      await tx.restore(FIELD_PEER)
      await tx.setProperty(FIELD_ID, presetIdProp, 'number')
    }, {scope: ChangeScope.BlockDefault})).rejects.toMatchObject({
      code: 'property.definition-change.contested',
    })

    // Rolled back WHOLE. Committing the re-type and skipping its fan-out was
    // the earlier answer, and it is wrong whenever the incumbent keeps the name
    // — which is most of the time, since the registry picks the older row: the
    // re-type lands and its consumers are read through the new codec in the old
    // encoding. Refusing needs no `createdAt` ordering to be correct.
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await rowContent(valueRowId)).toBe(' 42 ')
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string')
    expect(await isLive(FIELD_PEER)).toBe(false)
  })

  it('leaves value content untouched on a plain RESTORE', async () => {
    // A restore that changes no codec input must not re-encode: re-parsing is
    // not the identity for editable representations, so a speculative rewrite
    // would silently canonicalize text the user typed. `1.50` is the cheap
    // witness; a labelled ref value child losing its label is the expensive
    // one. The cost of NOT speculating is #1031.
    await seedWorkspace('children')
    const repo = await setupDefinition('number')
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 1.5)
    await setRawValueContent(valueRowId, '1.50')
    expect(await rowContent(valueRowId)).toBe('1.50')

    await repo.tx(tx => tx.delete(FIELD_ID), {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.restore(FIELD_ID), {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await rowContent(valueRowId)).toBe('1.50')
  })

  it('re-encodes a definition RESTORED and re-typed in the same tx', async () => {
    // Deleting a definition does not tombstone its consumers' field rows, so a
    // revival brings back a live registry entry over values still in the old
    // encoding. The tombstoned bag is the only record of what that encoding
    // was, and the metadata parse refuses a deleted row.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')
    await repo.tx(tx => tx.delete(FIELD_ID), {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      await tx.restore(FIELD_ID)
      await tx.setProperty(FIELD_ID, presetIdProp, 'number')
    }, {scope: ChangeScope.BlockDefault})

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('renames onto the name of a definition that STOPS being one in the same tx', async () => {
    // Stripping the `property-schema` type leaves a live row that the rebuilt
    // registry no longer publishes — so the name is free after commit, even
    // though nothing was deleted and the row is still there.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await createDefinition(repo, FIELD_PEER, 'former', 'string')
    await awaitDefinition(repo, 'former', 'string')

    await repo.tx(async tx => {
      const peer = await tx.get(FIELD_PEER)
      const withoutType = {...peer!.properties}
      delete withoutType.types
      await tx.update(FIELD_PEER, {properties: withoutType})
      await tx.setProperty(FIELD_ID, propertyNameProp, 'former')
    }, {scope: ChangeScope.BlockDefault})

    expect(await cell('p')).toEqual({former: 'done'})
  })

  it('renames onto the name of a definition DELETED in the same tx', async () => {
    // The peer is in the tx-start claimant list and can never be `vacating`,
    // which holds only rename candidates — so it would contest a destination it
    // is about to leave empty, and the fan-out would be skipped while the
    // definition row took the new name anyway.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await createDefinition(repo, FIELD_PEER, 'retired', 'string')
    await awaitDefinition(repo, 'retired', 'string')

    await repo.tx(async tx => {
      await tx.delete(FIELD_PEER)
      await tx.setProperty(FIELD_ID, propertyNameProp, 'retired')
    }, {scope: ChangeScope.BlockDefault})

    expect(await cell('p')).toEqual({retired: 'done'})
  })
})

describe('names a SEED claims', () => {
  it('refuses a rename onto a seed name whose definition row has not materialized', async () => {
    // `types` is a kernel seed. Until its row materializes it lives only in
    // `seedsByName`, so a claimant lookup that read `definitionsByName` alone
    // would report the name as FREE — and the fan-out would then write this
    // definition's values under the type-membership key of every consumer.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    expect(repo.propertyDefinitions?.definitionsByName.get('types')).toBeUndefined()

    await expect(rename(repo, FIELD_ID, 'types')).rejects.toMatchObject({
      code: 'property.definition-change.contested',
    })

    expect(await cell('p')).toEqual({status: 'done'})
    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
  })
})

describe('simultaneous name swap (a -> b AND b -> a in one tx)', () => {
  const FIELD_A = 'field-swap-a'
  const FIELD_B = 'field-swap-b'

  const setupPair = async (): Promise<Repo> => {
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    await createDefinition(repo, FIELD_A, 'alpha', 'string')
    await createDefinition(repo, FIELD_B, 'beta', 'string')
    await awaitDefinition(repo, 'alpha', 'string')
    await awaitDefinition(repo, 'beta', 'string')
    await createHost(repo, 'host')
    await repo.tx(tx => tx.setProperty('host', schemaFor(repo, 'alpha'), 'alpha-value'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('host', schemaFor(repo, 'beta'), 'beta-value'),
      {scope: ChangeScope.BlockDefault})
    expect(await cell('host')).toEqual({alpha: 'alpha-value', beta: 'beta-value'})
    return repo
  }

  it('keeps BOTH values: each lands under the other definition\'s old name', async () => {
    await seedWorkspace('children')
    const repo = await setupPair()
    const fieldA = await liveFieldRow('host', FIELD_A)
    const fieldB = await liveFieldRow('host', FIELD_B)
    expect(fieldA).toBeDefined()
    expect(fieldB).toBeDefined()

    // Both names edited in ONE tx, so the processor's changed-rows batch sees
    // both renames and applies them atomically (drop all old names before
    // assigning any new one) rather than one at a time.
    await repo.tx(async tx => {
      await tx.setProperty(FIELD_A, propertyNameProp, 'beta')
      await tx.setProperty(FIELD_B, propertyNameProp, 'alpha')
    }, {scope: ChangeScope.BlockDefault})

    // Each definition's value follows ITS fieldId to its new name — nothing is
    // clobbered, and neither field row is tombstoned by the materializer
    // reading a re-key as a user delete.
    expect(await cell('host')).toEqual({beta: 'alpha-value', alpha: 'beta-value'})
    expect(await liveFieldRow('host', FIELD_A)).toBe(fieldA)
    expect(await liveFieldRow('host', FIELD_B)).toBe(fieldB)
  })

  it('REFUSES a rename that collides with an existing owner\'s name', async () => {
    // `alpha` renamed onto `beta`, which a DIFFERENT definition still owns and
    // is NOT renaming away from. Re-keying would drop `alpha` and overwrite the
    // `beta` cell with alpha's value, while B is the one that keeps projecting
    // `beta`. Skipping the re-key was the earlier answer and committed the
    // rename anyway, leaving A's consumers keyed under a name A no longer
    // answered to; the whole transaction is refused instead (#1028).
    await seedWorkspace('children')
    const repo = await setupPair()
    const fieldA = await liveFieldRow('host', FIELD_A)
    const fieldB = await liveFieldRow('host', FIELD_B)

    await expect(rename(repo, FIELD_A, 'beta')).rejects.toMatchObject({
      code: 'property.definition-change.contested',
    })

    expect(await cell('host')).toEqual({alpha: 'alpha-value', beta: 'beta-value'})
    expect((await cell(FIELD_A))[propertyNameProp.name]).toBe('alpha')
    expect(await liveFieldRow('host', FIELD_A)).toBe(fieldA)
    expect(await liveFieldRow('host', FIELD_B)).toBe(fieldB)
  })
})

describe('name round-trip guard (§7)', () => {
  it('accepts ordinary names and rejects ]]-lossy ones', () => {
    expect(isRoundTrippableReferenceLabel('status')).toBe(true)
    expect(isRoundTrippableReferenceLabel('roam:isa')).toBe(true)
    expect(isRoundTrippableReferenceLabel('with spaces & (parens)')).toBe(true)
    expect(isRoundTrippableReferenceLabel('bad]]name')).toBe(false)
    expect(isRoundTrippableReferenceLabel('[[already-linked]]')).toBe(false)
    expect(isRoundTrippableReferenceLabel('')).toBe(false)
  })

  // The round-trip guard alone leaves a gap `addSchema` closes with the second
  // check: `((id))` and `::((id))` round-trip perfectly well (nothing about
  // them is `]]`-lossy), yet they read as a reference to a different block
  // wherever the name is rendered. `isGrammarShapedLabel` is what rejects them.
  it('leaves reference-shaped names to the grammar guard, which the round-trip one admits', () => {
    const UUID = '0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b'
    for (const name of [`((${UUID}))`, `::((${UUID}))`, '((field-status))']) {
      expect(isRoundTrippableReferenceLabel(name)).toBe(true)
      expect(isGrammarShapedLabel(name)).toBe(true)
    }
  })
})

describe('the multi-value boundary (#1010)', () => {
  const FIELD_PEER = 'field-peer-multivalue'

  /** A list-valued property's value rows, in tree order. `seedProperty` returns
   *  only the first; a list stores N sibling value children (#1010). */
  const seedListProperty = async (
    repo: Repo, blockId: string, name: string, value: readonly string[],
  ): Promise<string[]> => {
    await createHost(repo, blockId)
    await repo.tx(tx => tx.setProperty(blockId, schemaFor(repo, name), value),
      {scope: ChangeScope.BlockDefault})
    const field = await sharedDb.db.get<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ? AND deleted = 0',
      [blockId, FIELD_ID])
    return (await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [field.id])).map(row => row.id)
  }

  /** A SECOND field row for the same definition — what two offline devices
   *  materializing one value leave behind. Raw, because sync-apply never passes
   *  through `repo.tx` and so schedules no processor to normalize it. */
  const addDuplicateFieldRow = async (
    owner: string, members: readonly string[],
  ): Promise<void> => {
    await sharedDb.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
         properties_json, reference_target_id, is_field_form, deleted,
         created_at, updated_at, user_updated_at, created_by, updated_by)
       VALUES ('dupfield', ?, ?, 'zz', ?, '{}', ?, 1, 0, 1, 1, 1, 'user-1', 'user-1')`,
      [WS, owner, `::((${FIELD_ID}))`, FIELD_ID])
    for (const [i, member] of members.entries()) {
      await sharedDb.db.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
           properties_json, deleted, created_at, updated_at, user_updated_at,
           created_by, updated_by)
         VALUES (?, ?, 'dupfield', ?, ?, '{}', 0, 1, 1, 1, 'user-1', 'user-1')`,
        [`dupmember-${i}`, WS, `a${i}`, member])
    }
  }

  const liveMembers = async (owner: string): Promise<string[]> =>
    (await sharedDb.db.getAll<{content: string}>(
      `SELECT v.content FROM blocks v JOIN blocks f ON v.parent_id = f.id
        WHERE f.parent_id = ? AND f.reference_target_id = ? AND f.deleted = 0
          AND v.deleted = 0 AND v.is_field_form IS NOT 1
        ORDER BY v.order_key, v.id`,
      [owner, FIELD_ID])).map(row => row.content)

  it('re-encodes EVERY member, not just the first', async () => {
    // The scalar rule — take the first value child that parses — truncates a
    // list to one member, which is why the SECOND member is asserted. A
    // refList cell holds BARE IDS: the `((id))` span is how the child SPELLS
    // one, not what the property holds, so carrying the values across leaves
    // the cell untouched and leaves no span for a later rename or merge to
    // rewrite.
    await seedWorkspace('children')
    const repo = await setupDefinition('refList')
    await createHost(repo, 'a-id')
    await createHost(repo, 'b-id')
    const ids = await seedListProperty(repo, 'p', 'status', ['a-id', 'b-id'])
    expect(await rowContent(ids[0]!)).toBe('((a-id))')
    expect(await cell('p')).toEqual({status: ['a-id', 'b-id']})

    await retype(repo, FIELD_ID, 'string-list')

    expect(await cell('p')).toEqual({status: ['a-id', 'b-id']})
    expect(await rowContent(ids[1]!)).toBe('b-id')
  })

  it('UNIONS across duplicate field rows, as the projection does', async () => {
    // Two field rows carrying the same member are a transient sync conflict the
    // collapse folds away. Concatenating them publishes a DOUBLED cell, and
    // MATERIALIZE then folds one row to a single member and MINTS a second to
    // satisfy that cell — turning the transient duplicate into permanent,
    // user-visible multiplicity.
    await seedWorkspace('children')
    const repo = await setupDefinition('refList')
    await createHost(repo, 'a-id')
    await seedListProperty(repo, 'p', 'status', ['a-id'])
    await addDuplicateFieldRow('p', ['((a-id))'])

    await retype(repo, FIELD_ID, 'string-list')

    expect(await cell('p')).toEqual({status: ['a-id']})
    // The duplicate ROW survives, and should: this pass is `settledWrites`, so
    // no materializer follows it, and folding the two rows is the collapse's
    // job rather than this one's. What must not happen is the DOUBLED cell —
    // that is what turns a transient conflict into permanent multiplicity,
    // because whoever reconciles next mints a row to satisfy it.
    expect(await liveMembers('p')).toHaveLength(2)
  })

  it('unions across duplicate field rows on a RENAME too', async () => {
    // Same rule, and this processor is `settledWrites` — no materializer or
    // projector follows it, so a doubled cell would stay doubled until some
    // later child edit happened to reproject.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    await seedListProperty(repo, 'p', 'status', ['alpha'])
    await addDuplicateFieldRow('p', ['alpha'])

    await rename(repo, FIELD_ID, 'state')

    expect(await cell('p')).toEqual({state: ['alpha']})
  })

  it('REFUSES when duplicate field rows CONVERGE on one member', async () => {
    // A loss with nothing unreadable in it: two rows holding DIFFERENT values
    // (the string `42` and the number 42) re-spell to the same text, so the
    // union that the projection takes folds them into one member. Nothing is
    // unconvertible; the cell still stops holding a value, so the same
    // refusal applies.
    await seedWorkspace('children')
    const repo = await setupDefinition('list')
    await seedListProperty(repo, 'p', 'status', ['42'])
    // Raw, so the cell is not reprojected — the duplicate is visible only to
    // the union this pass takes, which is where the two values meet.
    await addDuplicateFieldRow('p', ['42'])
    expect(await cell('p')).toEqual({status: ['42']})

    await expect(retype(repo, FIELD_ID, 'string-list')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
    })
    expect(await cell('p')).toEqual({status: ['42']})
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('list')
  })

  it('keeps a value that is literally the word `null` (#1030)', async () => {
    // The one end-to-end witness that `string` -> `list` carries the value
    // rather than parsing it — `list` being the only identity preset a person
    // can pick. This value is chosen because getting it wrong changes the
    // cell's TYPE and not just its spelling: the old codec REJECTS null, so
    // the row held the literal word, and reading the text under a codec that
    // accepts null makes it a JSON null (#1030).
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 'null')
    expect(await cell('p')).toEqual({status: 'null'})

    await retype(repo, FIELD_ID, 'list')
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: ['null']})
    expect(await rowContent(valueRowId)).toBe('"null"')
  })

  it('scalar -> list reads the one value child as a single member', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', 'alpha')

    await retype(repo, FIELD_ID, 'string-list')

    expect(await cell('p')).toEqual({status: ['alpha']})
    expect(await rowContent(valueRowId)).toBe('alpha')
  })

  it('REFUSES list -> scalar when the scalar has no room for every member', async () => {
    // Every member converts on its own, so a per-ROW loss check sees nothing —
    // the loss is at cell grain, where the scalar aggregate keeps only the
    // first. Publishing it drops `beta` from the cell, and MATERIALIZE then
    // folds its row away on the next ordinary write to the property, so
    // "the row stays visible and fixable" does not survive contact.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    const ids = await seedListProperty(repo, 'p', 'status', ['alpha', 'beta'])

    await expect(retype(repo, FIELD_ID, 'string')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      meta: {count: 1, blockIds: ['p']},
    })
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: ['alpha', 'beta']})
    expect(await rowContent(ids[1]!)).toBe('beta')
  })

  it('allows list -> scalar when the list holds ONE member', async () => {
    // The narrowing itself is not the loss — the members past the first are.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    await seedListProperty(repo, 'p', 'status', ['alpha'])

    await retype(repo, FIELD_ID, 'string')
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: 'alpha'})
  })

  it('keeps an EXPLICITLY empty list, field row and all', async () => {
    // A stored `[]` read as "nothing projected" unsets the key, and MATERIALIZE
    // then tombstones the field row the empty list was stored in. The rule
    // lives in the shared aggregate so every caller that saw a field row gets
    // it.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    await createHost(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', schemaFor(repo, 'status'), []),
      {scope: ChangeScope.BlockDefault})
    const fieldRowId = await liveFieldRow('p', FIELD_ID)
    expect(fieldRowId).toBeDefined()

    await retype(repo, FIELD_ID, 'refList')

    expect(await cell('p')).toEqual({status: []})
    expect(await isLive(fieldRowId!)).toBe(true)
  })

  it('refuses a PARTIAL list conversion, and keeps every member', async () => {
    // A partial list is not a smaller list — it is the members the user still
    // has silently missing from every reader of that cell. The refusal takes
    // the member that DID convert back with it, which is the point: the list
    // is left exactly as it was.
    //
    // Bare id-shaped strings are what a refList member must refuse: there is
    // no grammar in them, so nothing can tell one from prose. Re-spelling the
    // string `alpha` as `((alpha))` is no way round that — it would mint an
    // identity nobody wrote — so route 2 declines and both stay lost.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    await createHost(repo, 'a-id')
    const ids = await seedListProperty(repo, 'p', 'status', ['x', 'alpha', 'beta'])
    // Member 0 becomes a bare span, which the ref member codec converts.
    // Through the TREE, not the cell, because the string member codec would
    // escape a span.
    await repo.tx(tx => tx.update(ids[0]!, {content: '((a-id))'}),
      {scope: ChangeScope.BlockDefault})
    const before = await cell('p')

    await expect(retype(repo, FIELD_ID, 'refList')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      meta: {count: 2, blockIds: ['p']},
    })
    await repo.awaitProcessors()

    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string-list')
    expect(await cell('p')).toEqual(before)
    expect(await rowContent(ids[0]!)).toBe('((a-id))')
    expect(await rowContent(ids[1]!)).toBe('alpha')
    expect(await rowContent(ids[2]!)).toBe('beta')
    expect(await isLive(ids[1]!), ids[1]).toBe(true)
  })

  it('refuses list -> SCALAR rather than publishing over a member that did not convert', async () => {
    // The sole pin for the CONVERTED sibling rolling back too: ` 1 ` would have
    // been canonicalized to `1`, and the refusal takes that write with it.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    const ids = await seedListProperty(repo, 'p', 'status', ['bad', ' 1 '])

    await expect(retype(repo, FIELD_ID, 'number')).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      meta: {count: 1},
    })
    await repo.awaitProcessors()

    expect(await rowContent(ids[0]!)).toBe('bad')
    expect(await rowContent(ids[1]!)).toBe(' 1 ')
    expect(await cell('p')).toEqual({status: ['bad', ' 1 ']})
    expect(await isLive(ids[0]!)).toBe(true)
    expect(await isLive(ids[1]!)).toBe(true)
  })

  it('does not stamp an empty list on a parent that carries no field row for it', async () => {
    // `consumingParentIds` returns every parent holding a field row for ANY
    // changed definition, so a parent consuming only one of two is visited for
    // both. The null gate is what keeps the other change off it: an empty group
    // aggregates to `[]` under a list codec, which is a VALUE — this parent
    // would gain a key it never had.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    await createDefinition(repo, FIELD_PEER, 'other', 'string')
    await awaitDefinition(repo, 'other', 'string')
    await seedListProperty(repo, 'p', 'status', ['alpha'])
    const {valueRowId} = await seedProperty(repo, 'q', 'other', 'done', FIELD_PEER)
    expect(await cell('q')).toEqual({other: 'done'})

    // ONE tx renaming both, so both are changes in the same batch.
    await repo.tx(async tx => {
      await tx.setProperty(FIELD_ID, propertyNameProp, 'state')
      await tx.setProperty(FIELD_PEER, propertyNameProp, 'another')
    }, {scope: ChangeScope.BlockDefault})

    expect(await cell('q')).toEqual({another: 'done'})
    expect(await cell('p')).toEqual({state: ['alpha']})
    expect(await rowContent(valueRowId)).toBe('done')
  })

  it('re-encodes between two LIST presets that share a codec type (#1024)', async () => {
    // `string-list` and the generic `list` preset both report `codec.type ===
    // 'list'`, so a detector keyed on the type string sees no change. At member
    // grain they disagree about the child TEXT: `string-list` stores a string
    // member verbatim (`x`), the generic one stores it as JSON (`"x"`).
    // Left un-re-encoded, `x` is then read as JSON, `JSON.parse` fails, and the
    // projection drops every member — the whole list, silently.
    //
    // Two halves fix it. Keying on the codec's INPUTS SEES the change: the
    // preset id moved, and nothing derived from the built codec did. Reading
    // the member under the codec that WROTE it then converts it — the value is
    // the string `x` either way, and only its spelling moves.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    // `42` is the only member here that the text route could also read, so it
    // is the only one that pins the ROUTE (`spellingThatHolds`) rather than
    // just the re-encode. It stays the STRING it was.
    const ids = await seedListProperty(repo, 'p', 'status', ['x', 'y', '42'])
    const errors = collectUserErrors(repo)
    expect(await rowContent(ids[0]!)).toBe('x')

    await retype(repo, FIELD_ID, 'list')
    await repo.awaitProcessors()

    expect(await rowContent(ids[0]!)).toBe('"x"')
    expect(await rowContent(ids[1]!)).toBe('"y"')
    expect(await cell('p')).toEqual({status: ['x', 'y', '42']})
    // The one place this channel is still worth asserting on: a refusal throws
    // out of the awaited `repo.tx` and would fail the test above it, so an
    // empty list here only rules out one leaking from an internal tx.
    expect(errors).toEqual([])
  })

  it('ESCAPES a member the target codec would otherwise store as a live span', async () => {
    // The value route re-spells under the TARGET codec, so escaping is its
    // duty too: a generic `list` stores the string `((a-id))` as JSON with the
    // parens intact, and written verbatim into a `string-list` row the inline
    // reference reader takes it as a pointer — a later rename or merge then
    // edits the value.
    await seedWorkspace('children')
    const repo = await setupDefinition('list')
    const ids = await seedListProperty(repo, 'p', 'status', ['((a-id))'])

    await retype(repo, FIELD_ID, 'string-list')
    await repo.awaitProcessors()

    expect(await rowContent(ids[0]!)).not.toMatch(/[[(]/)
    expect(await cell('p')).toEqual({status: ['((a-id))']})
  })

  it('keeps quotes the person typed, which the text route would strip', async () => {
    // A string member can legitimately BE a quoted string: `"quoted"` is
    // stored verbatim and the cell holds it WITH its quotes. Re-reading that
    // text as JSON unwraps it, so the text route answers with a different,
    // shorter value nobody wrote — and unlike the list case, nothing about the
    // spelling looks wrong afterwards.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    await seedListProperty(repo, 'p', 'status', ['"quoted"'])
    expect(await cell('p')).toEqual({status: ['"quoted"']})

    await retype(repo, FIELD_ID, 'list')
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({status: ['"quoted"']})
  })

  it('returns the same members after a round trip through the other list preset (#1055)', async () => {
    // Coming back, the JSON text `"x"` READS under the string member codec —
    // which accepts anything — so reading the TEXT would make the member the
    // three-character string `"x"`. Reading the VALUE first is what keeps the
    // pair symmetric: the codec that WROTE the text settles what it spells.
    await seedWorkspace('children')
    const repo = await setupDefinition('string-list', undefined, 'list')
    const ids = await seedListProperty(repo, 'p', 'status', ['x', 'y'])

    await retype(repo, FIELD_ID, 'list')
    await awaitDefinition(repo, 'status', 'list')
    expect(await rowContent(ids[0]!)).toBe('"x"')

    await retype(repo, FIELD_ID, 'string-list')
    await repo.awaitProcessors()

    expect(await rowContent(ids[0]!)).toBe('x')
    expect(await cell('p')).toEqual({status: ['x', 'y']})
  })

  it('re-keys the members it CAN read past one it cannot, on a rename', async () => {
    // A rename touches no encoding, so an unreadable member is pre-existing
    // staleness and must not take the rest of the list with it. Publishing
    // nothing here drops the OLD key — which the rename removes — and never
    // writes the new one, so the property disappears from the block outright.
    await seedWorkspace('children')
    const repo = await setupDefinition('refList')
    await createHost(repo, 'a-id')
    const ids = await seedListProperty(repo, 'p', 'status', ['a-id', 'b-id'])
    await setRawValueContent(ids[1]!, 'not a reference')
    expect(await cell('p')).toEqual({status: ['a-id', 'b-id']})

    await rename(repo, FIELD_ID, 'state')
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({state: ['a-id']})
    expect(await rowContent(ids[1]!)).toBe('not a reference')
    expect(await isLive(ids[1]!), ids[1]).toBe(true)
  })
})

describe('while the cell-to-children backfill holds this workspace\'s claim', () => {
  /** A claim row as SYNC delivers one: written raw, so no processor runs over
   *  it and nothing in the test depends on the claim seam's own write path. */
  const seedBackfillClaim = async (
    {completed = false, workspaceId = WS}: {completed?: boolean; workspaceId?: string} = {},
  ): Promise<string> => {
    const id = graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID)
    const properties = addBlockTypeToProperties({
      [migrationClaimantProp.name]: 'peer-device',
      [migrationClaimedAtProp.name]: 1,
      ...(completed ? {[migrationCompletedAtProp.name]: 2} : {}),
    }, MIGRATION_CLAIM_TYPE)
    await sharedDb.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
         properties_json, deleted, created_at, updated_at, user_updated_at,
         created_by, updated_by)
       VALUES (?, ?, NULL, 'k-claim', ?, ?, 0, 1, 1, 1, 'user-1', 'user-1')`,
      [id, workspaceId, PROPERTY_CELL_BACKFILL_ID, JSON.stringify(properties)],
    )
    return id
  }

  /** A parent the backfill has NOT reached yet: a cell and no field row.
   *
   *  Written RAW because that is the only way to get this shape — the same
   *  shape a row that predates the flip has. `setProperty` on a flipped
   *  workspace materializes the children this parent is defined by not having,
   *  and those children are exactly what makes the fan-out able to see it. */
  const seedCellOnlyProperty = async (
    repo: Repo, blockId: string, name: string, value: unknown,
  ): Promise<void> => {
    await createHost(repo, blockId)
    await sharedDb.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({[name]: value}), blockId],
    )
  }

  it('refuses a rename, and the cell-only parent keeps a key that still resolves', async () => {
    // The mixed case, which is the whole hazard: `backfilled` has field rows and
    // would be re-keyed, `cellOnly` has none and would not — leaving its value
    // under a name the registry no longer publishes, which later backfill
    // batches skip as unregistered and nothing ever visits again.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'backfilled', 'status', 'done')
    await seedCellOnlyProperty(repo, 'cell-only', 'status', 'pending')
    await seedBackfillClaim()

    await expect(rename(repo, FIELD_ID, 'state')).rejects.toMatchObject({
      code: 'property.definition-change.migration-running',
    })

    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
    expect(await cell('backfilled')).toEqual({status: 'done'})
    expect(await cell('cell-only')).toEqual({status: 'pending'})
  })

  it('refuses a re-type', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedCellOnlyProperty(repo, 'cell-only', 'status', 'pending')
    await seedBackfillClaim()

    await expect(retype(repo, FIELD_ID, 'number')).rejects.toMatchObject({
      code: 'property.definition-change.migration-running',
    })

    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string')
  })

  it('refuses although the definition has NO field row anywhere', async () => {
    // The WORST case, not an exempt one: a definition with no field rows is one
    // whose every consumer is cell-only. The fan-out is dormant for it —
    // `consumingParentIds` finds nothing — so a refusal that asked "does this
    // have consumers" the way the two other refusals do would pass it through.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedCellOnlyProperty(repo, 'cell-only', 'status', 'pending')
    await seedBackfillClaim()

    await expect(rename(repo, FIELD_ID, 'state')).rejects.toMatchObject({
      code: 'property.definition-change.migration-running',
    })
    // The gate itself, asserted rather than assumed: it is blind to this
    // parent, which is why the refusal must not consult it.
    expect(await consumingParentIds(sharedDb.db, WS, [FIELD_ID])).toEqual([])
    expect(await cell('cell-only')).toEqual({status: 'pending'})
  })

  it('names the MIGRATION, not the broken type, when the re-type is also unbuildable', async () => {
    // Position: above the unbuildable hold. Both refusals apply and the user
    // fixes one thing at a time, so the one to name is the one that is true of
    // the whole workspace — repairing the preset would not make this edit land.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await seedBackfillClaim()

    await expect(retype(repo, FIELD_ID, 'no-such-preset')).rejects.toMatchObject({
      code: 'property.definition-change.migration-running',
    })
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string')
  })

  it('refuses an unbuildable re-type that no consumer would otherwise hold up', async () => {
    // The unbuildable refusal is gated on FIELD-ROW consumers, so with none it
    // commits — and a `changes`-only claim check placed below it would too,
    // because an unbuildable change never becomes a `change`.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedCellOnlyProperty(repo, 'cell-only', 'status', 'pending')
    await seedBackfillClaim()

    await expect(retype(repo, FIELD_ID, 'no-such-preset')).rejects.toMatchObject({
      code: 'property.definition-change.migration-running',
    })
    expect((await cell(FIELD_ID))[presetIdProp.name]).toBe('string')
  })

  it('lets the rename through once the claim records a COMPLETED run', async () => {
    // A completed claim is never released — it is the graph's record that the
    // pass ran. Reading it as active would refuse definition edits in this
    // workspace for good.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await seedBackfillClaim({completed: true})

    await rename(repo, FIELD_ID, 'state')

    expect(await cell('p')).toEqual({state: 'done'})
  })

  it('lets the rename through when the claim block is gone', async () => {
    // Deleting the claim is the documented recovery for a device that died
    // mid-pass, and the message this refusal carries tells the operator to do
    // exactly that — so a tombstone has to read as "not running".
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    const claimId = await seedBackfillClaim()
    await sharedDb.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [claimId])

    await rename(repo, FIELD_ID, 'state')

    expect(await cell('p')).toEqual({state: 'done'})
  })

  it('ignores a claim row at this id owned by ANOTHER workspace', async () => {
    // The id is derived from the workspace but the row is not scoped by it —
    // an import that keeps its ids lands a foreign block here, and reading it
    // unscoped would let another graph's migration freeze this one's editing.
    await seedWorkspace('children')
    await seedWorkspace('children', 'ws-elsewhere')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await seedBackfillClaim({workspaceId: 'ws-elsewhere'})

    await rename(repo, FIELD_ID, 'state')

    expect(await cell('p')).toEqual({state: 'done'})
  })

  it('refuses a CONTESTED rename that no field-row consumer would hold up', async () => {
    // #1028's own refusal of a contested change is gated on field-row
    // consumers, so with none it commits: the row takes its new name and the
    // consumers it did not re-key keep the old one. That is this refusal's
    // case, not that one's — the cell-only consumer is invisible to the probe
    // both of them would otherwise ask.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await createDefinition(repo, 'field-state', 'state', 'string')
    await awaitDefinition(repo, 'state', 'string')
    await seedCellOnlyProperty(repo, 'cell-only', 'status', 'pending')
    await seedBackfillClaim()

    await expect(rename(repo, FIELD_ID, 'state')).rejects.toMatchObject({
      code: 'property.definition-change.migration-running',
    })
    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('status')
    expect(await cell('cell-only')).toEqual({status: 'pending'})
  })

  it('leaves a contested rename alone when no migration is running', async () => {
    // The control, and the boundary of this PR: with no field-row consumer to
    // trip #1028's refusal and no claim to trip this one, a contested rename
    // commits its row with no fan-out. Whether that should refuse too is
    // #1028's question, and this refusal must not have quietly taken it over.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await createDefinition(repo, 'field-state', 'state', 'string')
    await awaitDefinition(repo, 'state', 'string')

    await rename(repo, FIELD_ID, 'state')

    expect((await cell(FIELD_ID))[propertyNameProp.name]).toBe('state')
  })

  it('lets a definition be CREATED, which is how the gesture mints its own', async () => {
    // The migration gesture holds this claim across orphan-definition synthesis
    // and mints definitions under it. A created row has no `before`, so no
    // change is collected and this refusal never sees it.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedBackfillClaim()

    await createDefinition(repo, 'field-priority', 'priority', 'string')

    expect((await cell('field-priority'))[propertyNameProp.name]).toBe('priority')
  })

  it('lets an unrelated bag write on a definition through', async () => {
    // Every write to a definition's bag reaches this processor, the
    // materializer's own field-row bookkeeping included. Refusing those would
    // freeze far more than renaming for the length of the pass.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'done')
    await seedBackfillClaim()

    await repo.tx(async tx => {
      const definition = await tx.get(FIELD_ID)
      await tx.update(FIELD_ID, {
        properties: {...definition!.properties, 'test:unrelated': 'note'},
      })
    }, {scope: ChangeScope.BlockDefault})

    expect((await cell(FIELD_ID))['test:unrelated']).toBe('note')
    expect(await cell('p')).toEqual({status: 'done'})
  })
})

describe('sizing the fan-out before it starts', () => {
  /** The gesture's count and the fan-out's walk answer the same question
   *  through one predicate, so these are about what that predicate CALLS a
   *  consumer — a number that over-reports asks the user to wait for work
   *  that never happens, and one that under-reports lets the app freeze after
   *  promising it would not. */
  it('counts the parents the fan-out will actually visit, once each', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p1', 'status', 'done')
    await seedProperty(repo, 'p2', 'status', 'todo')

    expect(await repo.countPropertyDefinitionConsumers(FIELD_ID, WS)).toBe(2)
    expect(await consumingParentIds(sharedDb.db, WS, [FIELD_ID])).toHaveLength(2)
  })

  it('does not count a plain reference to the definition', async () => {
    // An unmarked `((fieldId))` row is a link somebody wrote, not a field row,
    // and the fan-out passes it by. Counting it would put a number in the
    // confirmation that nothing in the transaction corresponds to.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await createHost(repo, 'mentions')
    await repo.tx(async tx => {
      await tx.create({
        id: 'mention-row', workspaceId: WS, parentId: 'mentions', orderKey: 'm0',
        content: `((${FIELD_ID}))`,
      })
    }, {scope: ChangeScope.BlockDefault})
    // The precondition the assertion is about: the row DID resolve to the
    // definition, so it is only the field-form bit keeping it out.
    expect(await referenceTargetOf('mention-row')).toBe(FIELD_ID)

    expect(await repo.countPropertyDefinitionConsumers(FIELD_ID, WS)).toBe(0)
  })

  it('leaves out an owner that is itself deleted', async () => {
    // `deleted = 0` on the field row does not cover the OWNER, and a
    // tombstoned block can still hold live field rows. The fan-out declines
    // to re-key those, so counting them tells the user their change will
    // rewrite blocks it then passes over — and on a graph with a long delete
    // history that number is what decides whether they are asked at all.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p1', 'status', 'done')
    await seedProperty(repo, 'p2', 'status', 'todo')
    await repo.tx(tx => tx.delete('p2'), {scope: ChangeScope.BlockDefault})
    // The precondition the assertion is about: the field row under the dead
    // owner is still live, so only the owner's own state keeps it out.
    expect(await liveFieldRow('p2', FIELD_ID)).toBeDefined()

    expect(await repo.countPropertyDefinitionConsumers(FIELD_ID, WS)).toBe(1)
    expect(await consumingParentIds(sharedDb.db, WS, [FIELD_ID])).toEqual(['p1'])
  })

  it('stops counting a consumer whose field row is gone', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p1', 'status', 'done')
    await repo.tx(tx => tx.unsetProperty('p1', schemaFor(repo, 'status')),
      {scope: ChangeScope.BlockDefault})

    expect(await repo.countPropertyDefinitionConsumers(FIELD_ID, WS)).toBe(0)
  })
})

describe('reporting fan-out progress', () => {
  afterEach(() => { __resetPropertyDefinitionFanoutForTests() })

  it('reports into a run the gesture opened', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p1', 'status', 'done')
    const run = beginPropertyDefinitionFanout(WS, FIELD_ID, 'status', 1)
    try {
      expect(propertyDefinitionFanout()?.done).toBeNull()
      markPropertyDefinitionFanoutRunning(WS, FIELD_ID)

      await rename(repo, FIELD_ID, 'state')

      expect(propertyDefinitionFanout()).toMatchObject({done: 1, total: 1})
    } finally {
      run.end()
    }
    expect(propertyDefinitionFanout()).toBeNull()
  })

  it('reports the LAST consumer, whatever the stride lands on', async () => {
    // Without it the surface sits at the previous stride for the whole tail —
    // "1,000 of 1,124 blocks updated" while the transaction commits, and then
    // it vanishes. Three consumers is the cheapest total that is neither 1
    // nor a multiple of the stride.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    for (const id of ['p1', 'p2', 'p3']) await seedProperty(repo, id, 'status', 'done')
    const run = beginPropertyDefinitionFanout(WS, FIELD_ID, 'status', 3)
    try {
      markPropertyDefinitionFanoutRunning(WS, FIELD_ID)
      await rename(repo, FIELD_ID, 'state')

      expect(propertyDefinitionFanout()).toMatchObject({done: 3, total: 3})
    } finally {
      run.end()
    }
  })

  it('opens no surface of its own for a caller that did not ask for one', async () => {
    // A headless rename — the agent CLI, an importer — has nobody to show a
    // modal to, and a store entry nothing clears would strand one over the
    // next tab that reads it.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p1', 'status', 'done')

    await rename(repo, FIELD_ID, 'state')

    expect(propertyDefinitionFanout()).toBeNull()
  })
})
