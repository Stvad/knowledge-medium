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
import { ChangeScope, type AnyPropertySchema, type ProcessorRejection } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { isGrammarShapedLabel, isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import { presetIdProp, propertyChangeScopeProp, propertyNameProp } from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { withoutContestedRenames } from './internals/propertyDefinitionChangeProcessor'
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
const setupDefinition = async (presetId = 'string'): Promise<Repo> => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
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

describe('withoutContestedRenames', () => {
  const change = (fieldId: string, oldName: string, newName: string) =>
    ({fieldId, oldName, newName})
  const owners = (map: Record<string, string>) => (name: string) => map[name]

  it('drops a rename onto a NEW name a different, non-migrating definition owns', () => {
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'beta')], owners({alpha: 'a', beta: 'b'}),
    )).toEqual([])
  })

  it('drops a rename whose OLD name a different definition now answers to', () => {
    expect(withoutContestedRenames(
      [change('a', 'shared', 'alpha')], owners({shared: 'b'}),
    )).toEqual([])
  })

  it('keeps a swap — each contested name is owned by a peer migrating in the same batch', () => {
    const swap = [change('a', 'alpha', 'beta'), change('b', 'beta', 'alpha')]
    expect(withoutContestedRenames(swap, owners({alpha: 'a', beta: 'b'})))
      .toEqual(swap)
  })

  it('re-contests a rename whose exempting peer was itself dropped', () => {
    // `a -> beta` is exempt only while `b` vacates `beta`; but `b -> gamma`
    // collides with a third, non-migrating owner and is dropped, which
    // un-vacates `beta` and takes `a` with it on the next round.
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'beta'), change('b', 'beta', 'gamma')],
      owners({alpha: 'a', beta: 'b', gamma: 'c'}),
    )).toEqual([])
  })

  it('refuses the exemption to a codec-only peer, which vacates nothing', () => {
    // `b` is in the batch (its codec changed) but KEEPS the name `beta`, so it
    // cannot free it for `a`.
    expect(withoutContestedRenames(
      [change('a', 'alpha', 'beta'), change('b', 'beta', 'beta')],
      owners({alpha: 'a', beta: 'b'}),
    )).toEqual([change('b', 'beta', 'beta')])
  })

  it('keeps an uncontested rename, and a codec-only change that keeps its name', () => {
    const changes = [change('a', 'alpha', 'gamma'), change('b', 'beta', 'beta')]
    expect(withoutContestedRenames(changes, owners({alpha: 'a', beta: 'b'})))
      .toEqual(changes)
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

  it('is dormant in an un-flipped workspace', async () => {
    await seedWorkspace('cell')
    const repo = await setupDefinition()
    await createHost(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', schemaFor(repo, 'status'), 'done'),
      {scope: ChangeScope.BlockDefault})

    await rename(repo, FIELD_ID, 'state')

    // Cell keeps the old key (today's rename semantics), no children exist —
    // `isPropertyChildBackedWorkspace` keeps the processor dormant.
    expect(await cell('p')).toEqual({status: 'done'})
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
