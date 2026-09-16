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
  type AnyPropertySchema,
  type AnyValuePresetCore,
  type ProcessorRejection,
} from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { valuePresetCoresFacet } from '@/data/facets'
import { isGrammarShapedLabel, isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import { presetIdProp, propertyChangeScopeProp, propertyNameProp } from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import {
  consumingParentIds,
  withoutContestedRenames,
} from './internals/propertyDefinitionChangeProcessor'
import type { Repo } from './repo'

const WS = 'ws-def-change'
const FIELD_ID = 'field-status-change'

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
afterEach(() => { vi.useRealTimers() })

const seedWorkspace = async (propertiesMigration: string): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, ?)`,
    [WS, propertiesMigration],
  )
}

/** A REAL property-schema definition block: `types: ['property-schema']` plus
 *  name / change-scope / PRESET. The preset is what makes this the production
 *  shape — `userSchemasProjector` builds real behavior from it, so the registry
 *  entry the processor's identity gate consults and the codec it re-encodes
 *  under both come from this row, exactly as they do in the app. */
const createDefinition = async (
  repo: Repo, fieldId: string, name: string, presetId: string,
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id: fieldId, workspaceId: WS, parentId: null, orderKey: `k-${fieldId}`, content: name,
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

/** A workspace with one live `status` definition at `FIELD_ID`. */
const setupDefinition = async (
  presetId = 'string', extensions?: readonly AnyValuePresetCore[],
): Promise<Repo> => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    ...(extensions
      ? {extensions: extensions.map(core => valuePresetCoresFacet.of(core, {source: 'test'}))}
      : {}),
  })
  repo.setActiveWorkspaceId(WS)
  await createDefinition(repo, FIELD_ID, 'status', presetId)
  await awaitDefinition(repo, 'status', presetId)
  return repo
}

const rename = (repo: Repo, fieldId: string, newName: string): Promise<void> =>
  repo.tx(tx => tx.setProperty(fieldId, propertyNameProp, newName),
    {scope: ChangeScope.BlockDefault})

const retype = (repo: Repo, fieldId: string, presetId: string): Promise<void> =>
  repo.tx(tx => tx.setProperty(fieldId, presetIdProp, presetId),
    {scope: ChangeScope.BlockDefault})

/** The unconvertible-values report rides `afterCommit`, so it lands one
 *  post-commit tx after the edit resolves. */
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

describe('withoutContestedRenames', () => {
  const change = (fieldId: string, oldName: string, newName: string) =>
    ({fieldId, oldName, newName})
  /** name -> claimants, WINNER FIRST — the shape the registry's
   *  `definitionsByName` has, and the multiplicity the un-shadowing refusal
   *  needs. A single-entry list is the ordinary unshadowed case. */
  const claimants = (map: Record<string, string[]>) =>
    (name: string): readonly string[] => map[name] ?? []

  it('drops a rename onto a NEW name a different, non-migrating definition owns', () => {
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'beta')], claimants({alpha: ['a'], beta: ['b']}),
    )).toEqual([])
  })

  it('drops a rename whose OLD name a different definition now answers to', () => {
    expect(withoutContestedRenames(
      [change('a', 'shared', 'alpha')], claimants({shared: ['b', 'a']}),
    )).toEqual([])
  })

  it('keeps a swap — each contested name is owned by a peer migrating in the same batch', () => {
    const swap = [change('a', 'alpha', 'beta'), change('b', 'beta', 'alpha')]
    expect(withoutContestedRenames(swap, claimants({alpha: ['a'], beta: ['b']})))
      .toEqual(swap)
  })

  it('re-contests a rename whose exempting peer was itself dropped', () => {
    // `a -> beta` is exempt only while `b` vacates `beta`; but `b -> gamma`
    // collides with a third, non-migrating owner and is dropped, which
    // un-vacates `beta` and takes `a` with it on the next round.
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'beta'), change('b', 'beta', 'gamma')],
      claimants({alpha: ['a'], beta: ['b'], gamma: ['c']}),
    )).toEqual([])
  })

  it('drops a rename that UN-SHADOWS a peer sharing the old name', () => {
    // `a` wins `shared` and renames away, which hands `shared` to `b`. Asking
    // who OWNS `shared` names `a` itself — it still holds it at tx start — so
    // only the full claimant list can see `b` about to inherit the key this
    // rename would drop.
    expect(withoutContestedRenames(
      [change('a', 'shared', 'alpha')], claimants({shared: ['a', 'b'], alpha: []}),
    )).toEqual([])
  })

  it('keeps a codec-only change on a name it shares with a shadowed peer', () => {
    // The peer under `shared` is the status quo, not something a re-type
    // creates: nothing is vacated, so the old-name half does not apply.
    const codecOnly = [change('a', 'shared', 'shared')]
    expect(withoutContestedRenames(codecOnly, claimants({shared: ['a', 'b']})))
      .toEqual(codecOnly)
  })

  it('refuses the exemption to a codec-only peer, which vacates nothing', () => {
    // `b` is in the batch (its codec changed) but KEEPS the name `beta`, so it
    // cannot free it for `a`.
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'beta'), change('b', 'beta', 'beta')],
      claimants({alpha: ['a'], beta: ['b']}),
    )).toEqual([change('b', 'beta', 'beta')])
  })

  it('drops two renames converging on one previously unclaimed name', () => {
    // Neither sees a tx-start claimant for `gamma`, so only the batch itself
    // can tell they collide. Letting both through assigns that key twice and
    // the last writer wins — which need not be the definition the rebuilt
    // registry picks.
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'gamma'), change('b', 'beta', 'gamma')],
      claimants({alpha: ['a'], beta: ['b']}),
    )).toEqual([])
  })

  // `null` is "nothing here can be judged", not "nobody claims this name" — the
  // permissive reading would approve a rename onto a seed-owned key in a
  // workspace with no registry snapshot. Split per NAME because either clause
  // alone drops the candidate, so a single test with both unknown leaves
  // whichever one is deleted covered by the other.
  it('refuses a rename whose DESTINATION cannot be judged', () => {
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'beta')],
      (name) => name === 'beta' ? null : [],
    )).toEqual([])
  })

  it('refuses a rename whose VACATED name cannot be judged', () => {
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'beta')],
      (name) => name === 'alpha' ? null : [],
    )).toEqual([])
  })

  it('keeps an uncontested rename, and a codec-only change that keeps its name', () => {
    const changes = [change('a', 'alpha', 'gamma'), change('b', 'beta', 'beta')]
    expect(withoutContestedRenames(changes, claimants({alpha: ['a'], beta: ['b']})))
      .toEqual(changes)
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

  it('leaves value text alone, and reports nothing, even when it is stale', async () => {
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
    const errors = collectUserErrors(repo)

    await rename(repo, FIELD_ID, 'state')
    await repo.awaitProcessors()

    expect(await rowContent(valueRowId)).toBe('1.50')
    expect(await rowContent(staleRowId)).toBe('not a number')
    expect(errors).toEqual([])
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

  it('reports unconvertible values and KEEPS the stale cell key, leaving rows in the tree', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'status', 'not a number')
    const errors = collectUserErrors(repo)

    await retype(repo, FIELD_ID, 'number')
    await repo.awaitProcessors()

    // All-unconvertible must NOT unset the cell key: MATERIALIZE reads a missing
    // key as delete-intent and would tombstone the very rows the user is told
    // are preserved (#800). The stale old-codec value is what stays.
    expect(await cell('p')).toEqual({status: 'not a number'})
    expect(await rowContent(valueRowId)).toBe('not a number')
    expect(await isLive(fieldRowId), fieldRowId).toBe(true)
    expect(await isLive(valueRowId), valueRowId).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.code).toBe('property.codec-change.unconvertible')
    expect(errors[0]!.meta).toMatchObject({name: 'status', count: 1})
  })

  it('counts every unconvertible value across every consumer, not just the first', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    await seedProperty(repo, 'p', 'status', 'not a number')
    await seedProperty(repo, 'q', 'status', 'also not a number')
    const errors = collectUserErrors(repo)

    await retype(repo, FIELD_ID, 'number')
    await repo.awaitProcessors()

    // One report per definition, summed over consumers — a per-parent early
    // exit here would under-report the damage.
    expect(errors).toHaveLength(1)
    expect(errors[0]!.meta).toMatchObject({count: 2})
  })

  it('leaves a value that already reads as the new type alone', async () => {
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', '42')
    const errors = collectUserErrors(repo)

    await retype(repo, FIELD_ID, 'number')
    await repo.awaitProcessors()

    expect(await rowContent(valueRowId)).toBe('42')
    expect(await cell('p')).toEqual({status: 42})
    expect(errors).toEqual([])
  })

  it('re-encodes on the tx that REPAIRS a definition with no buildable codec', async () => {
    // A preset that cannot build leaves the definition behaviour-less: the
    // registry publishes metadata only, and nothing on this device can say what
    // codec its stored values are in. Repairing it to a working preset is the
    // only moment the re-encode can happen, and the old codec is not needed to
    // do it — the conversion parses the child's TEXT under the new one.
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')
    await retype(repo, FIELD_ID, 'no-such-preset')
    await vi.waitFor(() => {
      if (repo.propertySchemas.get('status') !== undefined) {
        throw new Error('[test] status still has behaviour in the registry')
      }
    }, {timeout: 3000})

    await retype(repo, FIELD_ID, 'number')

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('re-stamps the reference columns when a ref value becomes plain text', async () => {
    // Retyping a ref property rewrites `((id))` into escaped text AFTER
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

    expect(await rowContent(valueRowId)).not.toBe('((target))')
    expect(await referenceTargetOf(valueRowId)).toBeNull()
  })

  it('survives a preset whose build THROWS, and still repairs off it', async () => {
    // `preset.build` is extension code. The projector catches a throw and
    // publishes metadata only; here an escape would abort the user's own
    // transaction — and the transaction it would abort is the one repairing the
    // broken definition.
    const throwing = {
      id: 'test-throwing-preset',
      build: () => { throw new Error('[test] preset build failed') },
      defaultValue: '',
    } as unknown as AnyValuePresetCore
    await seedWorkspace('children')
    const repo = await setupDefinition('string', [throwing])
    const {valueRowId} = await seedProperty(repo, 'p', 'status', ' 42 ')

    await retype(repo, FIELD_ID, throwing.id)
    await vi.waitFor(() => {
      if (repo.propertySchemas.get('status') !== undefined) {
        throw new Error('[test] status still has behaviour in the registry')
      }
    }, {timeout: 3000})
    // The re-type onto the broken preset built nothing, so nothing fanned out.
    expect(await rowContent(valueRowId)).toBe(' 42 ')

    await retype(repo, FIELD_ID, 'number')

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('rename + re-type in ONE edit: value rows stay live, cell unsets per §9', async () => {
    // Both triggers in one tx: `status` (string) becomes `state` (number), and
    // the existing value does not convert.
    //
    // The DATA guarantee is that the value ROWS survive — the field row's
    // content is id-addressed and rename-stable, and the value child keeps its
    // text. The CELL ends UNSET: the pass drops the old key and has nothing
    // parseable to project under the new one (§9's default-value rule).
    await seedWorkspace('children')
    const repo = await setupDefinition()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'status', 'not a number')
    const errors = collectUserErrors(repo)

    await repo.tx(async tx => {
      await tx.setProperty(FIELD_ID, propertyNameProp, 'state')
      await tx.setProperty(FIELD_ID, presetIdProp, 'number')
    }, {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await cell('p')).toEqual({})
    expect(await rowContent(valueRowId)).toBe('not a number')
    expect(await rowContent(fieldRowId)).toBe(`::((${FIELD_ID}))`)
    expect(await isLive(fieldRowId), fieldRowId).toBe(true)
    expect(await isLive(valueRowId), valueRowId).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.meta).toMatchObject({name: 'state', count: 1})
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

    await rename(repo, FIELD_ID, 'types')

    expect(await cell('p')).toEqual({status: 'done'})
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

  it('does NOT clobber an existing owner when a rename collides with its name', async () => {
    // `alpha` renamed onto `beta`, which a DIFFERENT definition still owns and
    // is NOT renaming away from. Without the collision refusal the re-key would
    // drop `alpha` and overwrite the `beta` cell with alpha's value — but B is
    // the one that keeps projecting `beta`. The whole re-key must be skipped.
    await seedWorkspace('children')
    const repo = await setupPair()
    const fieldA = await liveFieldRow('host', FIELD_A)
    const fieldB = await liveFieldRow('host', FIELD_B)

    await rename(repo, FIELD_A, 'beta')

    expect(await cell('host')).toEqual({alpha: 'alpha-value', beta: 'beta-value'})
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
