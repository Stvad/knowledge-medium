// @vitest-environment node
/**
 * Slice B2 (PR #288 §7/§9): rename-reproject + codec-change re-encode.
 * A definition rename or codec change under a durable fieldId triggers a
 * child-indexed migration — cell re-key, value re-encode, with unconvertible
 * values reported — both flip-gated (dormant in a 'cell' workspace).
 *
 * The two triggers now run on DIFFERENT paths (PR #386 follow-up): a RENAME
 * is a same-tx processor (`MIGRATE_PROPERTY_RENAME_PROCESSOR`,
 * `internals/propertyRenameProcessor.ts`) — it fires inside the same
 * `repo.tx` that edits the definition block's name, so the rename and its
 * consuming-cell fan-out land as ONE undoable step. A codec-TYPE change
 * still rides the deferred deep-idle batch this file's `republish` helper
 * drains (it needs the NEW codec, which the same-tx registry snapshot can't
 * build). Field rows are id-addressed (`((fieldId))`, §7) either way, so
 * neither path retitles them — only the name-keyed cell re-keys.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty, ProcessorRejection } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { isGrammarShapedLabel, isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import { propertyChangeScopeProp, propertyNameProp } from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import {
  changedPropertyDefinitionFacts,
  propertyDefinitionFacts,
  withoutContestedRenames,
} from './internals/propertyDefinitionMigrations'
import { PROPERTY_DEFINITION_BASELINE_PREFIX } from './internals/clientSchema'
import type { Repo } from './repo'

const WS = 'ws-def-migrations'
const FIELD_ID = 'field-status-migrations'
const OTHER_WS = 'ws-def-migrations-other'
const THIRD_WS = 'ws-def-migrations-third'

const schemaWith = (name: string, codec = codecs.string as typeof codecs.string | typeof codecs.number) =>
  defineProperty(name, {
    codec: codec as typeof codecs.string,
    defaultValue: (codec === codecs.number ? 0 : '') as never,
    changeScope: ChangeScope.BlockDefault,
  })

// ONE instance per (name, codec): plain-schema resolution matches by
// identity, so the instance published as the definition's behavior must be
// the instance handed to setProperty.
const statusString = schemaWith('status')
const statusNumber = schemaWith('status', codecs.number)
// Rename AND codec change in the SAME republish (status/string -> state2/number).
const state2Number = schemaWith('state2', codecs.number)

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

const publishDefinition = (
  repo: Repo,
  schema: ReturnType<typeof schemaWith>,
): void => {
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-status-definition',
    [{
      metadata: {
        fieldId: FIELD_ID,
        workspaceId: WS,
        createdAt: 1,
        name: schema.name,
        changeScope: schema.changeScope,
        hidden: false,
        origin: 'user' as const,
      },
      schema,
    }],
    {workspaceId: WS},
  )
}

const setup = (initial = statusString): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  publishDefinition(repo, initial)
  return repo
}

/** Publish a definition change and drain the migration pass it schedules.
 *  Fake timers must be on BEFORE the publish — the deep-idle deferral is a
 *  timer, and one armed under real timers is invisible to
 *  `runAllTimersAsync`. */
const republish = async (repo: Repo, schema: ReturnType<typeof schemaWith>): Promise<void> => {
  vi.useFakeTimers()
  publishDefinition(repo, schema)
  await vi.runAllTimersAsync()
  await repo.awaitPropertyDefinitionMigrations()
  vi.useRealTimers()
}

const cell = async (id: string): Promise<Record<string, unknown>> => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id],
  )
  return JSON.parse(row.properties_json) as Record<string, unknown>
}

/** fieldId -> recorded baseline name, from the stored blob. */
const baselineNames = async (workspaceId = WS): Promise<Record<string, string>> => {
  const row = await sharedDb.db.getOptional<{value: string | null}>(
    'SELECT value FROM client_schema_state WHERE key = ?',
    [`${PROPERTY_DEFINITION_BASELINE_PREFIX}${workspaceId}`],
  )
  const fields = (JSON.parse(row?.value ?? '{}') as {
    fields?: Record<string, {name: string}>
  }).fields ?? {}
  return Object.fromEntries(Object.entries(fields).map(([id, entry]) => [id, entry.name]))
}

const rowContent = async (id: string): Promise<string> =>
  (await sharedDb.db.get<{content: string}>(
    'SELECT content FROM blocks WHERE id = ?', [id],
  )).content

/** Set a property in the flipped workspace and return the field/value ids. */
const seedProperty = async (
  repo: Repo, blockId: string, value: string,
): Promise<{fieldRowId: string; valueRowId: string}> => {
  await repo.tx(async tx => {
    await tx.create({
      id: blockId, workspaceId: WS, parentId: null, orderKey: `k-${blockId}`, content: 'host',
    })
  }, {scope: ChangeScope.BlockDefault})
  await repo.tx(tx => tx.setProperty(blockId, statusString, value),
    {scope: ChangeScope.BlockDefault})
  const field = await sharedDb.db.get<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ? AND deleted = 0',
    [blockId, FIELD_ID],
  )
  const valueRow = await sharedDb.db.get<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [field.id],
  )
  return {fieldRowId: field.id, valueRowId: valueRow.id}
}

/** A REAL property-schema definition block — `types: ['property-schema']`
 *  plus `propertyNameProp`/`propertyChangeScopeProp`, the shape
 *  `parsePropertyDefinitionMetadata` recognizes. This is the row the
 *  same-tx rename processor reads before/after; registering the schema in
 *  the projected facet (`publishDefinition`, above) is the SEPARATE
 *  tx-start identity/codec lookup (`ctx.resolvePropertySchemaField`) — a
 *  rename test needs BOTH, at the same `fieldId`.
 *
 *  This block deliberately omits a presetId, so the app's OWN live
 *  `userSchemasProjector` bridge (which reacts to any `'property-schema'`
 *  row) can't build real behavior for it and publishes metadata-only,
 *  WARNING "no presetId" — racing our manual override for the same fieldId
 *  key in `projectedPropertyDefinitionsFacet`. Waiting here for that
 *  reaction to land (metadata visible in the registry) before returning
 *  means a caller who publishes its OWN override right after is guaranteed
 *  to register LATER and so win the facet's "last-wins" dedup — otherwise
 *  the projector's reaction can land asynchronously AFTER the override and
 *  silently reclobber it (a real race, not a hypothetical one — this is
 *  what made the naive "create then publish" ordering still flaky). */
const seedDefinitionBlock = async (
  repo: Repo, fieldId: string, name: string,
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id: fieldId, workspaceId: WS, parentId: null, orderKey: `k-${fieldId}`, content: name,
      properties: {
        types: [PROPERTY_SCHEMA_TYPE],
        [propertyNameProp.name]: name,
        [propertyChangeScopeProp.name]: ChangeScope.BlockDefault,
      },
    })
  }, {scope: ChangeScope.BlockDefault})
  await vi.waitFor(() => {
    if (repo.propertyDefinitions?.definitionsByFieldId.get(fieldId)?.name !== name) {
      throw new Error(`[test] ${fieldId} not yet visible in the property-definitions registry`)
    }
  })
}

/** Rename a real definition block's name in ONE tx — this is what actually
 *  triggers `MIGRATE_PROPERTY_RENAME_PROCESSOR` (a same-tx processor; no
 *  timer drain needed, unlike the deferred codec-change path below). */
const renameDefinitionBlock = async (
  repo: Repo, fieldId: string, newName: string,
): Promise<void> => {
  await repo.tx(tx => tx.setProperty(fieldId, propertyNameProp, newName),
    {scope: ChangeScope.BlockDefault})
}

/** `setup()` PLUS a real definition block at `FIELD_ID` — for the rename
 *  tests, which (unlike the codec-change tests) need a real block to edit.
 *  ORDER matters here: `seedDefinitionBlock` alone (no presetId) is also
 *  picked up by the live `userSchemasProjector` bridge, which publishes a
 *  metadata-only ("no presetId", `schema` omitted) contribution at the SAME
 *  fieldId key — so publishing our override AFTER the block exists is what
 *  makes it the surviving "last-wins" registration (facet dedup convention,
 *  `keyedMapFacet`) instead of getting shadowed by the schema-less one. */
const setupWithRealDefinition = async (
  initial: ReturnType<typeof schemaWith> = statusString,
): Promise<Repo> => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await seedDefinitionBlock(repo, FIELD_ID, initial.name)
  publishDefinition(repo, initial)
  return repo
}

describe('definition facts (diff inputs)', () => {
  const snapshotWith = (
    definitions: ReadonlyArray<{fieldId: string; name: string; seedKey?: string}>,
    codecTypes: ReadonlyMap<string, string> = new Map(),
  ) => ({
    workspaceId: WS,
    schemas: new Map(),
    definitionsByFieldId: new Map(definitions.map(definition => [definition.fieldId, {
      ...definition, workspaceId: WS, createdAt: 1,
      changeScope: ChangeScope.BlockDefault, hidden: false, origin: 'user' as const,
    }])),
    definitionsByName: new Map(),
    schemasByFieldId: new Map(
      [...codecTypes].map(([fieldId, type]) => [fieldId, {codec: {type}}]),
    ),
    seedsByKey: new Map(),
    seedsByName: new Map(),
  })

  it('omits seed-provenanced definitions, whose effective name depends on load order', () => {
    const facts = propertyDefinitionFacts(snapshotWith([
      {fieldId: 'user-field', name: 'Status'},
      {fieldId: 'seed-field', name: 'Done', seedKey: 'system:kernel-data/property/done'},
    ]) as never)
    expect([...facts.keys()]).toEqual(['user-field'])
  })

  it('reports a rename, and a codec change only when BOTH sides resolved one', () => {
    const previous = propertyDefinitionFacts(
      snapshotWith([{fieldId: 'f', name: 'a'}], new Map([['f', 'string']])) as never,
    )
    expect(changedPropertyDefinitionFacts(
      previous,
      propertyDefinitionFacts(snapshotWith([{fieldId: 'f', name: 'b'}]) as never),
    )).toEqual([{fieldId: 'f', oldName: 'a', newName: 'b', codecChanged: false}])
    expect(changedPropertyDefinitionFacts(
      previous,
      propertyDefinitionFacts(
        snapshotWith([{fieldId: 'f', name: 'a'}], new Map([['f', 'number']])) as never,
      ),
    )).toEqual([{fieldId: 'f', oldName: 'a', newName: 'a', codecChanged: true}])
  })

  it('reads a fieldId absent from the previous side as ADDED, never as a rename', () => {
    expect(changedPropertyDefinitionFacts(
      new Map(),
      propertyDefinitionFacts(snapshotWith([{fieldId: 'f', name: 'b'}]) as never),
    )).toEqual([])
  })
})

describe('withoutContestedRenames', () => {
  const rename = (fieldId: string, oldName: string, newName: string) =>
    ({fieldId, oldName, newName})

  it('drops a rename onto a NEW name a different, non-migrating definition owns', () => {
    expect(withoutContestedRenames(
      [rename('f1', 'a', 'b')], (name: string) => (name === 'b' ? 'f2' : undefined),
    )).toEqual([])
  })

  it('drops a rename whose OLD name a different definition now answers to', () => {
    expect(withoutContestedRenames(
      [rename('f1', 'a', 'b')], (name: string) => (name === 'a' ? 'f2' : undefined),
    )).toEqual([])
  })

  it('keeps a swap — each contested name is owned by a peer migrating in the same batch', () => {
    const swap = [rename('f1', 'a', 'b'), rename('f2', 'b', 'a')]
    expect(withoutContestedRenames(
      swap, (name: string) => (name === 'b' ? 'f2' : 'f1'),
    )).toEqual(swap)
  })

  it('keeps an uncontested rename, and a codec-only change that keeps its name', () => {
    expect(withoutContestedRenames(
      [rename('f1', 'a', 'b')], () => undefined,
    )).toHaveLength(1)
    expect(withoutContestedRenames([rename('f1', 'a', 'a')], () => 'f1')).toHaveLength(1)
  })
})

describe('rename migration (flipped workspace)', () => {
  it('re-keys consuming cells; field-row content is id-stable across the rename', async () => {
    await seedWorkspace('children')
    const repo = await setupWithRealDefinition()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'done')
    expect(await cell('p')).toEqual({status: 'done'})

    await renameDefinitionBlock(repo, FIELD_ID, 'state')

    // Field rows address the definition BY ID (`::((fieldId))`, §7), so a rename
    // never retitles their content — only the name-keyed cell re-keys.
    expect(await rowContent(fieldRowId)).toBe(`::((${FIELD_ID}))`)
    expect(await cell('p')).toEqual({state: 'done'})
    expect(await rowContent(valueRowId)).toBe('done')
  })

  it('is dormant in an un-flipped workspace', async () => {
    await seedWorkspace('cell')
    const repo = await setupWithRealDefinition()
    await repo.tx(async tx => {
      await tx.create({
        id: 'p', workspaceId: WS, parentId: null, orderKey: 'k', content: 'host',
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', statusString, 'done'),
      {scope: ChangeScope.BlockDefault})

    await renameDefinitionBlock(repo, FIELD_ID, 'state')

    // Cell keeps the old key (today's rename semantics), no children exist —
    // the flip gate (`isPropertyChildBackedWorkspace`) keeps the same-tx
    // processor dormant in a 'cell' workspace, so no re-key happens.
    expect(await cell('p')).toEqual({status: 'done'})
  })

  // The deferred-path "workspace moves on twice before the idle drain" repro
  // (PR #386 review defect: `propertySchemaResolverFor`'s one-deep active/
  // previous-workspace retention going stale before a deferred deep-idle job
  // fired) was removed here. A same-tx rename has no deferred plan that can
  // go stale — it runs inside the SAME tx that edits the definition block,
  // so there is no idle-drain window left for this staleness to occur in.

  it('a rename does NOT tombstone the field row or value child', async () => {
    await seedWorkspace('children')
    const repo = await setupWithRealDefinition()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'done')

    await renameDefinitionBlock(repo, FIELD_ID, 'state')

    // The DANGEROUS trap the processor's file header documents: the tx-start
    // registry still maps the OLD name ('status') -> this definition, so if
    // MATERIALIZE_PROPERTY_CHILDREN re-saw the re-keyed cell (old key
    // dropped), it would read that as a user delete and tombstone these very
    // rows. The rename processor runs LAST in `KERNEL_SAME_TX_PROCESSORS` to
    // dodge that — assert the rows actually survived it.
    for (const id of [fieldRowId, valueRowId]) {
      const row = await sharedDb.db.get<{deleted: number}>(
        'SELECT deleted FROM blocks WHERE id = ?', [id],
      )
      expect(row.deleted, `${id} deleted`).toBe(0)
    }
  })

  it('a rename is ONE undoable step', async () => {
    await seedWorkspace('children')
    const repo = await setupWithRealDefinition()
    await seedProperty(repo, 'p', 'done')
    expect(await cell('p')).toEqual({status: 'done'})

    await renameDefinitionBlock(repo, FIELD_ID, 'state')
    expect(await cell('p')).toEqual({state: 'done'})

    await repo.undo(ChangeScope.BlockDefault)

    // Both halves of the atomic rename — the definition block's own name AND
    // the consuming cell's re-key — revert together, in the one undo step.
    const defRow = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [FIELD_ID],
    )
    expect((JSON.parse(defRow.properties_json) as Record<string, unknown>)[propertyNameProp.name])
      .toBe('status')
    expect(await cell('p')).toEqual({status: 'done'})
  })
})

describe('codec-change migration', () => {
  it('re-encodes convertible values canonically and re-keys the cell', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')

    await republish(repo, statusNumber)

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  })

  it('reports unconvertible values and KEEPS the stale cell key, leaving rows in the tree', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {valueRowId} = await seedProperty(repo, 'p', 'not a number')
    const errors: ProcessorRejection[] = []
    repo.onUserError(err => { errors.push(err) })

    await republish(repo, statusNumber)

    // All-unconvertible must NOT delete the cell key — deleting it would
    // read as delete-intent to the same-tx materialize processor and
    // tombstone the very rows the user was told stay "fixable in the
    // outline" (see runPropertyDefinitionMigration's comment in repo.ts).
    // The stale (pre-migration, old-codec) value is what's left in place.
    expect(await cell('p')).toEqual({status: 'not a number'})
    expect(await rowContent(valueRowId)).toBe('not a number')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.code).toBe('property.codec-change.unconvertible')
    expect(errors[0]!.meta).toMatchObject({count: 1})
  })

  it('all-unconvertible: the field row and value child stay live (deleted = 0), never tombstoned', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'not a number')

    await republish(repo, statusNumber)

    // Neither the field row nor its value child was tombstoned by the
    // cell-key-deletion → materialize-delete-intent path — a bare
    // `deleted` probe (not `includePropertyChildren`) is the direct check
    // that the migration itself never called delete/deleteSubtree on them.
    for (const id of [fieldRowId, valueRowId]) {
      const row = await sharedDb.db.get<{deleted: number}>(
        'SELECT deleted FROM blocks WHERE id = ?', [id],
      )
      expect(row.deleted, `${id} deleted`).toBe(0)
    }
    // Also visible through the ordinary property-children read surface.
    const values = await repo.tx(
      tx => tx.childrenOf(fieldRowId),
      {scope: ChangeScope.BlockDefault},
    )
    expect(values.map(v => v.id)).toContain(valueRowId)
    // The cell still carries the stale key/value (not unset).
    expect(await cell('p')).toEqual({status: 'not a number'})
  })

  it('rename + all-unconvertible: value ROWS stay live, cell unsets per §9 (no data loss)', async () => {
    // Combines both migration triggers in one republish: `status` (string)
    // becomes `state2` (number), and the existing value doesn't convert.
    //
    // The DATA guarantee is that the value ROWS survive — they do: the field
    // row's content is id-addressed (`((fieldId))`) and rename-stable, and the
    // value child keeps `not a number`, both live. The CELL, however, ends
    // UNSET: because the content is rename-stable, NO MATERIALIZE/PROJECT
    // fires, so the migration pass is the sole cell writer — it drops the old
    // key and leaves the new one absent (nothing parseable to project, §9's
    // default-value rule). The pass never deletes value rows, so they stay
    // live unconditionally.
    await seedWorkspace('children')
    const repo = setup()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'not a number')
    const errors: ProcessorRejection[] = []
    repo.onUserError(err => { errors.push(err) })

    await republish(repo, state2Number)

    // Cell reads unset (§9 default-value rule) — NOT left under the old name.
    expect(await cell('p')).toEqual({})
    // The raw value is preserved as a live row (this is the real guarantee),
    // and the unconvertible count is surfaced to the user.
    expect(await rowContent(valueRowId)).toBe('not a number')
    expect(await rowContent(fieldRowId)).toBe(`::((${FIELD_ID}))`)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.code).toBe('property.codec-change.unconvertible')
    expect(errors[0]!.meta).toMatchObject({count: 1})

    // The field row and its value child stay live — never tombstoned.
    for (const id of [fieldRowId, valueRowId]) {
      const row = await sharedDb.db.get<{deleted: number}>(
        'SELECT deleted FROM blocks WHERE id = ?', [id],
      )
      expect(row.deleted, `${id} deleted`).toBe(0)
    }
  })
})

describe('simultaneous name swap (a -> b AND b -> a in one rebuild)', () => {
  const FIELD_A = 'field-swap-a'
  const FIELD_B = 'field-swap-b'
  const alpha = schemaWith('alpha')
  const beta = schemaWith('beta')

  const publishPair = (repo: Repo, a: typeof alpha, b: typeof beta): void => {
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-swap-definitions',
      [
        {
          metadata: {
            fieldId: FIELD_A, workspaceId: WS, createdAt: 1, name: a.name,
            changeScope: a.changeScope, hidden: false, origin: 'user' as const,
          },
          schema: a,
        },
        {
          metadata: {
            fieldId: FIELD_B, workspaceId: WS, createdAt: 1, name: b.name,
            changeScope: b.changeScope, hidden: false, origin: 'user' as const,
          },
          schema: b,
        },
      ],
      {workspaceId: WS},
    )
  }

  const liveFieldRow = async (blockId: string, fieldId: string): Promise<string | undefined> =>
    (await sharedDb.db.get<{id: string} | undefined>(
      'SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ? AND deleted = 0',
      [blockId, fieldId],
    ))?.id

  it('keeps BOTH values: each lands under the other definition\'s old name', async () => {
    await seedWorkspace('children')
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    // Real blocks FIRST, then the facet override — see `setupWithRealDefinition`
    // for why the order matters (the blocks' own live schema-bridge projector
    // races the manual override for the same fieldId keys).
    await seedDefinitionBlock(repo, FIELD_A, 'alpha')
    await seedDefinitionBlock(repo, FIELD_B, 'beta')
    publishPair(repo, alpha, beta)

    await repo.tx(async tx => {
      await tx.create({
        id: 'host', workspaceId: WS, parentId: null, orderKey: 'k-host', content: 'host',
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('host', alpha, 'alpha-value'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('host', beta, 'beta-value'),
      {scope: ChangeScope.BlockDefault})

    expect(await cell('host')).toEqual({alpha: 'alpha-value', beta: 'beta-value'})
    const fieldA = await liveFieldRow('host', FIELD_A)
    const fieldB = await liveFieldRow('host', FIELD_B)
    expect(fieldA).toBeDefined()
    expect(fieldB).toBeDefined()

    // The swap, in ONE tx: both definition blocks' names edited together, so
    // the processor's changed-rows batch sees BOTH renames and applies them
    // atomically (drop all old names before assigning any new one — see the
    // processor's `rekeyParent` comment) rather than one at a time.
    await repo.tx(async tx => {
      await tx.setProperty(FIELD_A, propertyNameProp, 'beta')
      await tx.setProperty(FIELD_B, propertyNameProp, 'alpha')
    }, {scope: ChangeScope.BlockDefault})

    // Each definition's value follows ITS fieldId to its new name — nothing is
    // clobbered by the other pass, and neither field row is tombstoned by the
    // materializer reading a re-key as a user delete.
    expect(await cell('host')).toEqual({beta: 'alpha-value', alpha: 'beta-value'})
    expect(await liveFieldRow('host', FIELD_A)).toBe(fieldA)
    expect(await liveFieldRow('host', FIELD_B)).toBe(fieldB)
  })

  it('does NOT clobber an existing owner when a rename collides with its name', async () => {
    // `alpha` renamed onto `beta`, which a DIFFERENT def (B) still owns and is
    // NOT renaming away from. Without the collision guard the re-key would drop
    // `alpha` and overwrite the `beta` cell with alpha's value — but B is the
    // one that keeps projecting `beta`. The whole re-key must be skipped and
    // left to the post-commit registry + PROJECT / #389 item 8.
    await seedWorkspace('children')
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    await seedDefinitionBlock(repo, FIELD_A, 'alpha')
    await seedDefinitionBlock(repo, FIELD_B, 'beta')
    publishPair(repo, alpha, beta)

    await repo.tx(async tx => {
      await tx.create({
        id: 'host', workspaceId: WS, parentId: null, orderKey: 'k-host', content: 'host',
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('host', alpha, 'alpha-value'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('host', beta, 'beta-value'),
      {scope: ChangeScope.BlockDefault})
    const fieldA = await liveFieldRow('host', FIELD_A)
    const fieldB = await liveFieldRow('host', FIELD_B)

    await repo.tx(tx => tx.setProperty(FIELD_A, propertyNameProp, 'beta'),
      {scope: ChangeScope.BlockDefault})

    // `beta` still carries B's value (NOT clobbered with `alpha-value`); the
    // re-key was skipped wholesale, so the cell is untouched and both field
    // rows stay live.
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

  // The round-trip guard alone leaves a gap `addSchema` closes with the
  // second check: `((id))` and `::((id))` round-trip through
  // `referenceBlockContentForLabel` perfectly well (nothing about them is
  // `]]`-lossy), yet they read as a reference to a different block wherever
  // the name is rendered. `isGrammarShapedLabel` is what rejects them.
  it('leaves reference-shaped names to the grammar guard, which the round-trip one admits', () => {
    const UUID = '0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b'
    for (const name of [`((${UUID}))`, `::((${UUID}))`, '((field-status))']) {
      expect(isRoundTrippableReferenceLabel(name)).toBe(true)
      expect(isGrammarShapedLabel(name)).toBe(true)
    }
  })
})

describe('changes observed only across a workspace switch (#780)', () => {
  const statusRenamed = schemaWith('state')

  /** Wait until the registry has primed on `workspaceId`, and (when given)
   *  carries `name` for FIELD_ID. `setActiveWorkspaceId` returns BEFORE the
   *  definition projector re-primes, so the rebuild that runs the baseline diff
   *  happens later — draining without this fence finds an empty queue for the
   *  wrong reason. */
  const awaitRegistry = async (
    repo: Repo, workspaceId: string, name?: string,
  ): Promise<void> => {
    await vi.waitFor(() => {
      const snapshot = repo.propertyDefinitions
      if (snapshot?.workspaceId !== workspaceId) {
        throw new Error(`[test] registry has not primed for ${workspaceId} yet`)
      }
      if (name !== undefined && snapshot.definitionsByFieldId.get(FIELD_ID)?.name !== name) {
        throw new Error(`[test] registry has not primed on ${name} yet`)
      }
    }, {timeout: 5000})
  }

  /** Switch away from WS, apply `next` to WS's (now invisible) definition
   *  bucket, then switch back.
   *
   *  Publishing while WS is inactive is the shape a SYNCED-IN change has: no
   *  `repo.tx` runs on this device, so the same-tx rename processor never
   *  fires. Waiting for OTHER_WS to prime makes it a real workspace visit
   *  (which is what rotates the resolver's previous slot); it does NOT make the
   *  return a cross-workspace diff — pinning WS rebuilds once with a null
   *  registry before its projector primes, so `previous` is null at the prime
   *  either way. */
  const changeWhileInactive = async (
    repo: Repo, next: ReturnType<typeof schemaWith>,
  ): Promise<void> => {
    repo.setActiveWorkspaceId(OTHER_WS)
    await awaitRegistry(repo, OTHER_WS)
    publishDefinition(repo, next)
    repo.setActiveWorkspaceId(WS)
    await awaitRegistry(repo, WS, next.name)
    await repo.awaitPropertyDefinitionBaselines()
  }

  it('re-keys cells for a rename that landed while the workspace was inactive', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', 'done')
    await repo.awaitPropertyDefinitionBaselines()
    expect(await cell('p')).toEqual({status: 'done'})

    await changeWhileInactive(repo, statusRenamed)

    await vi.waitFor(async () => {
      expect(await cell('p')).toEqual({state: 'done'})
    }, {timeout: 5000})
  }, 20_000)

  it('re-encodes values for a codec change that landed while the workspace was inactive', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()

    await changeWhileInactive(repo, statusNumber)

    await vi.waitFor(async () => {
      expect(await cell('p')).toEqual({status: 42})
    }, {timeout: 5000})
    expect(await rowContent(valueRowId)).toBe('42')
  }, 20_000)

  it('repairs a rename that synced in while the workspace was OPEN, at the next prime', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', 'done')
    await repo.awaitPropertyDefinitionBaselines()

    // Synced in while WS is ACTIVE: no local tx, so the same-tx processor never
    // sees it, and the bridge's in-memory diff schedules codec changes only —
    // nothing re-keys the cell now.
    publishDefinition(repo, statusRenamed)
    await awaitRegistry(repo, WS, 'state')
    await repo.awaitPropertyDefinitionBaselines()
    expect(await cell('p')).toEqual({status: 'done'})

    // Because nothing acted on it, the baseline must NOT have absorbed it —
    // the next prime is what repairs it.
    repo.setActiveWorkspaceId(OTHER_WS)
    await awaitRegistry(repo, OTHER_WS)
    repo.setActiveWorkspaceId(WS)

    await vi.waitFor(async () => {
      expect(await cell('p')).toEqual({state: 'done'})
    }, {timeout: 5000})
  }, 20_000)

  it('with NO recorded baseline, records one and migrates nothing', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', 'done')
    await repo.awaitPropertyDefinitionBaselines()
    // A device that has never recorded a baseline for this workspace — a fresh
    // install, or one whose `client_schema_state` was wiped. The drive below is
    // the SAME as the first test in this block, which DOES migrate; the only
    // difference is the missing before-state.
    await sharedDb.db.execute(
      `DELETE FROM client_schema_state WHERE key LIKE '${PROPERTY_DEFINITION_BASELINE_PREFIX}%'`,
    )
    const scheduled = vi.spyOn(repo, 'schedulePropertyDefinitionMigrations')

    await changeWhileInactive(repo, statusRenamed)

    // Not "everything changed": nothing is scheduled at all and the cell is
    // left alone. The baseline IS recorded, so the NEXT drift is detected.
    expect(scheduled).not.toHaveBeenCalled()
    expect(await cell('p')).toEqual({status: 'done'})
    expect(await baselineNames()).toEqual({[FIELD_ID]: 'state'})
  }, 20_000)

  it('folds every build into the baseline, so a change handled while active is migrated exactly once', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', ' 42 ')
    const scheduled = vi.spyOn(repo, 'schedulePropertyDefinitionMigrations')

    await republish(repo, statusNumber)
    await repo.awaitPropertyDefinitionBaselines()
    // The bridge's own in-memory diff owns a same-workspace build; the baseline
    // records it without also scheduling it.
    expect(await cell('p')).toEqual({status: 42})
    expect(scheduled).toHaveBeenCalledTimes(1)

    repo.setActiveWorkspaceId(OTHER_WS)
    await awaitRegistry(repo, OTHER_WS)
    repo.setActiveWorkspaceId(WS)
    await awaitRegistry(repo, WS)
    await repo.awaitPropertyDefinitionBaselines()

    // ...and coming back finds nothing to do, because that build was recorded.
    expect(scheduled).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('migrates against the resolver captured at rebuild time, after the workspace falls out of retention', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', 'done')
    publishDefinition(repo, statusRenamed)
    await awaitRegistry(repo, WS, 'state')
    // Captured the way the baseline path captures it: synchronously with the
    // rebuild, BEFORE its async read of the stored baseline.
    const resolver = repo.propertySchemaResolverFor(WS)

    // Two further switches evict WS from the one-deep active/previous retention
    // `propertySchemaResolverFor` serves from — the window that made the OLD
    // deferred pass drop migrations silently (PR #386 review). Each switch must
    // actually PRIME a registry: the previous-slot rotation only happens when a
    // non-null snapshot is replaced.
    for (const workspaceId of [OTHER_WS, THIRD_WS]) {
      repo.setActiveWorkspaceId(workspaceId)
      await awaitRegistry(repo, workspaceId)
    }
    expect(repo.propertySchemaResolverFor(WS).resolveField(FIELD_ID).status).not.toBe('resolved')

    repo.schedulePropertyDefinitionMigrations(
      WS, [{fieldId: FIELD_ID, oldName: 'status', newName: 'state', codecChanged: false}], resolver,
    )

    await vi.waitFor(async () => {
      expect(await cell('p')).toEqual({state: 'done'})
    }, {timeout: 5000})
  }, 20_000)

  it('migrates a definition that vanished from the registry and came back renamed', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', 'done')
    await repo.awaitPropertyDefinitionBaselines()

    // The definition drops out of the registry entirely (a delete, or any build
    // that observes a subset). The baseline is a UNION over builds, so it keeps
    // the fact — replacing it wholesale would make the return below look like a
    // brand-new definition and swallow the rename.
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet, 'test-status-definition', [], {workspaceId: WS},
    )
    await repo.awaitPropertyDefinitionBaselines()

    await changeWhileInactive(repo, statusRenamed)

    await vi.waitFor(async () => {
      expect(await cell('p')).toEqual({state: 'done'})
    }, {timeout: 5000})
  }, 20_000)
})

describe('contested names on the deferred path', () => {
  const F_RENAMED = 'field-contested-renamed'
  const F_OWNER = 'field-contested-owner'
  const F_PLAIN = 'field-contested-plain'

  // ONE instance per name — plain-schema resolution matches by identity, so a
  // freshly built duplicate would not resolve to the published definition.
  const SCHEMAS = new Map(
    ['a', 'zz', 'q', 'b', 'r'].map(name => [name, schemaWith(name)] as const),
  )

  const publishTrio = (repo: Repo, names: Record<string, string>): void => {
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-contested-definitions',
      [F_RENAMED, F_OWNER, F_PLAIN].map((fieldId, index) => ({
        metadata: {
          fieldId, workspaceId: WS, createdAt: index + 1, name: names[fieldId]!,
          changeScope: ChangeScope.BlockDefault, hidden: false, origin: 'user' as const,
        },
        schema: SCHEMAS.get(names[fieldId]!)!,
      })),
      {workspaceId: WS},
    )
  }

  const liveRows = async (blockId: string, fieldId: string): Promise<number> =>
    (await sharedDb.db.get<{n: number}>(
      `SELECT COUNT(*) AS n FROM blocks
        WHERE deleted = 0 AND (
          (parent_id = ? AND reference_target_id = ?)
          OR parent_id IN (SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ?))`,
      [blockId, fieldId, blockId, fieldId],
    )).n

  it('refuses a rename whose OLD name another definition now answers to, instead of tombstoning it', async () => {
    await seedWorkspace('children')
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    const initial = {[F_RENAMED]: 'a', [F_OWNER]: 'zz', [F_PLAIN]: 'q'}
    publishTrio(repo, initial)
    await repo.tx(async tx => {
      await tx.create({
        id: 'host', workspaceId: WS, parentId: null, orderKey: 'k-host', content: 'host',
      })
    }, {scope: ChangeScope.BlockDefault})
    for (const [fieldId, name] of Object.entries(initial)) {
      await repo.tx(tx => tx.setProperty('host', SCHEMAS.get(name)!, `v-${fieldId}`),
        {scope: ChangeScope.BlockDefault})
    }
    expect(await cell('host')).toEqual({
      a: `v-${F_RENAMED}`, zz: `v-${F_OWNER}`, q: `v-${F_PLAIN}`,
    })
    expect(await liveRows('host', F_OWNER)).toBe(2)

    // The state a rename lands in when it UN-SHADOWS a peer: `a` is now
    // F_OWNER's name. F_PLAIN renames uncontested in the same batch, as the
    // positive control that the pass really ran.
    publishTrio(repo, {[F_RENAMED]: 'b', [F_OWNER]: 'a', [F_PLAIN]: 'r'})
    await vi.waitFor(() => {
      if (repo.propertyDefinitions?.definitionsByFieldId.get(F_OWNER)?.name !== 'a') {
        throw new Error('[test] registry has not primed on the contested name yet')
      }
    }, {timeout: 5000})

    vi.useFakeTimers()
    repo.schedulePropertyDefinitionMigrations(WS, [
      {fieldId: F_RENAMED, oldName: 'a', newName: 'b', codecChanged: false},
      {fieldId: F_PLAIN, oldName: 'q', newName: 'r', codecChanged: false},
    ])
    await vi.runAllTimersAsync()
    await repo.awaitPropertyDefinitionMigrations()
    vi.useRealTimers()

    // The uncontested rename applied — so the pass demonstrably ran — while the
    // contested one left `a` alone. Dropping `a` would have made MATERIALIZE
    // read it as a user deletion and tombstone F_OWNER's field row and value.
    expect(await cell('host')).toEqual({
      a: `v-${F_RENAMED}`, zz: `v-${F_OWNER}`, r: `v-${F_PLAIN}`,
    })
    expect(await liveRows('host', F_OWNER)).toBe(2)
  }, 20_000)
})
