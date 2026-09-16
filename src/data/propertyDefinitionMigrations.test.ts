// @vitest-environment node
/**
 * Slice B2 (docs/properties-as-blocks-migration.html §7/§9): rename-reproject + codec-change re-encode.
 * A definition rename or codec change under a durable fieldId triggers a
 * child-indexed migration — cell re-key, value re-encode, with unconvertible
 * values reported — both flip-gated (dormant in a 'cell' workspace).
 *
 * The two triggers now run on DIFFERENT paths: a RENAME
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

/** The same definition with NO schema — the metadata-only shape
 *  `userSchemasService` publishes while a preset plugin is still loading. */
const publishDefinitionWithoutSchema = (repo: Repo, name: string): void => {
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-status-definition',
    [{
      metadata: {
        fieldId: FIELD_ID,
        workspaceId: WS,
        createdAt: 1,
        name,
        changeScope: ChangeScope.BlockDefault,
        hidden: false,
        origin: 'user' as const,
      },
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

const baselineCodecs = async (workspaceId = WS): Promise<Record<string, string>> => {
  const row = await sharedDb.db.getOptional<{value: string | null}>(
    'SELECT value FROM client_schema_state WHERE key = ?',
    [`${PROPERTY_DEFINITION_BASELINE_PREFIX}${workspaceId}`],
  )
  return (JSON.parse(row?.value ?? '{}') as {codecs?: Record<string, string>}).codecs ?? {}
}

/** The pass reports on ONE channel (`repo.onUserError`) and has two things to
 *  say — unconvertible values, and a cleared undo stack. An assertion about
 *  either must not be perturbed by the other arriving beside it. */
const rejectionsWithCode = (
  errors: readonly ProcessorRejection[], code: string,
): ProcessorRejection[] => errors.filter(error => error.code === code)

const UNCONVERTIBLE = 'property.codec-change.unconvertible'
const UNDO_CLEARED = 'property.codec-change.undo-cleared'

/** The rebuild snapshot `schedulePropertyDefinitionMigrations` takes, sampled
 *  the way the baseline path samples it: both halves together, synchronously,
 *  before any await. The generation is private, and reaching it through a cast
 *  is the idiom this file already uses for the batch. */
const rebuildSnapshot = (repo: Repo) => ({
  resolver: repo.propertySchemaResolverFor(WS),
  generation: (repo as unknown as {workspaceGeneration: number}).workspaceGeneration,
})

/** How deep the workspace's cmd-Z stack is — the thing a migration's writes
 *  can be silently reverted from. */
const undoDepth = (repo: Repo): number =>
  repo.undoManagerFor(WS).depths(ChangeScope.BlockDefault).undo

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
  }, {timeout: 3000})
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

  it('reports no codec change when the PREVIOUS side never resolved one', () => {
    // The baseline can hold a definition first seen while its preset was
    // loading. Reading that absence as a change would re-encode the whole
    // fleet the moment the preset arrives.
    expect(changedPropertyDefinitionFacts(
      propertyDefinitionFacts(snapshotWith([{fieldId: 'f', name: 'a'}]) as never),
      propertyDefinitionFacts(
        snapshotWith([{fieldId: 'f', name: 'a'}], new Map([['f', 'number']])) as never,
      ),
    )).toEqual([])
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

  it('re-contests a rename whose exempting peer was itself dropped', () => {
    // X keeps `a` free only because W is taking it; W is then dropped for
    // colliding on its own old name. Without a second pass X still drops `a`,
    // nothing re-sets it, and MATERIALIZE tombstones W's rows.
    const owners: Record<string, string> = {a: 'W', zz: 'V'}
    expect(withoutContestedRenames(
      [rename('X', 'a', 'b'), rename('W', 'zz', 'a')], (name: string) => owners[name],
    )).toEqual([])
  })

  it('refuses the exemption to a codec-only peer, which vacates nothing', () => {
    // W keeps the name it owns, so X's rename onto it is still a collision.
    expect(withoutContestedRenames(
      [rename('X', 'o', 'n'), rename('W', 'n', 'n')], (name: string) => (name === 'n' ? 'W' : undefined),
    )).toEqual([rename('W', 'n', 'n')])
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
  // (`propertySchemaResolverFor`'s one-deep active/previous-workspace
  // retention going stale before a deferred deep-idle job fired) was removed
  // here. A same-tx rename has no deferred plan that can
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
    expect(rejectionsWithCode(errors, UNCONVERTIBLE)).toHaveLength(1)
    expect(rejectionsWithCode(errors, UNCONVERTIBLE)[0]!.meta).toMatchObject({count: 1})
  })

  it('clears the workspace undo history on the first chunk that writes, and says so', async () => {
    await seedWorkspace('children')
    const repo = setup()
    // `42`, not ` 42 `: the text is already canonical under the new codec, so
    // the CELL re-key is the only thing that writes. Seeding a value that also
    // needed re-encoding would let the two write detectors cover for each
    // other, and neither would be pinned.
    const {valueRowId} = await seedProperty(repo, 'p', '42')
    const errors: ProcessorRejection[] = []
    repo.onUserError(err => { errors.push(err) })
    // The user's own edits, made BEFORE the codec change. An undo entry
    // restores a whole `before` row snapshot rather than a field delta, so any
    // one of these replays the pre-migration bag over a re-encoded row — and
    // permanently, because the baseline has by then recorded the drift as
    // applied and no later prime re-detects it. `skipUndo` keeps this pass's
    // own writes off the stack; it cannot reach the entries already on it.
    expect(undoDepth(repo)).toBeGreaterThan(0)

    await republish(repo, statusNumber)

    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
    expect(undoDepth(repo)).toBe(0)
    // Cleared AND surfaced: a user who finds cmd-Z silently empty has no way
    // to connect it to a property type change.
    expect(rejectionsWithCode(errors, UNDO_CLEARED)).toHaveLength(1)
  })

  it('clears the undo history when only a VALUE row needs re-encoding', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    const errors: ProcessorRejection[] = []
    repo.onUserError(err => { errors.push(err) })
    // The shape sync leaves behind: the CELL arrived already re-encoded from a
    // device that migrated, while this device still holds the old value text —
    // cell and children are separate rows and LWW settles them independently.
    // A raw write is how that shape is produced: it maintains the trigger-backed
    // side indexes but fires no post-commit processor, exactly like an applied
    // sync row.
    await sharedDb.db.writeTransaction(async tx => {
      await tx.execute(`UPDATE blocks SET properties_json = ? WHERE id = 'p'`,
        [JSON.stringify({status: 42})])
    })
    expect(undoDepth(repo)).toBeGreaterThan(0)

    await republish(repo, statusNumber)

    // Only the value row is rewritten — the cell converges on what it already
    // holds — so the cell re-key reports no write and the value re-encode is
    // the sole reason the user's history has to go.
    expect(await rowContent(valueRowId)).toBe('42')
    expect(await cell('p')).toEqual({status: 42})
    expect(undoDepth(repo)).toBe(0)
    expect(rejectionsWithCode(errors, UNDO_CLEARED)).toHaveLength(1)
  })

  it('clears when the USER canonicalized the only candidate, so the pass wrote nothing', async () => {
    // The whole-pass version of the intervening-edit case. The user edits the
    // only candidate between the scan and its chunk, which canonicalizes it
    // under the live schema and leaves an entry holding the OLD encoding. The
    // chunk then finds nothing to do, so a rule keyed on "the pass wrote"
    // preserves that entry — and the record below makes it permanent.
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', ' 42 ')
    const errors: ProcessorRejection[] = []
    repo.onUserError(err => { errors.push(err) })
    await repo.awaitPropertyDefinitionBaselines()

    // Stand in for the user's edit landing inside the pass's window: the
    // candidate scan has run, and the row is canonical by the time the chunk
    // reaches it.
    const batch = vi.spyOn(
      repo as unknown as {runPropertyDefinitionMigrationBatch: () => Promise<boolean>},
      'runPropertyDefinitionMigrationBatch',
    ).mockImplementation(async () => {
      await repo.tx(tx => tx.setProperty('p', statusNumber, 42 as never),
        {scope: ChangeScope.BlockDefault})
      return false
    })
    expect(undoDepth(repo)).toBeGreaterThan(0)

    await republish(repo, statusNumber)
    batch.mockRestore()

    // The pass recorded, so the entry the edit left behind would be permanent.
    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'number'})
    expect(undoDepth(repo)).toBe(0)
    expect(rejectionsWithCode(errors, UNDO_CLEARED)).toHaveLength(1)
  }, 20_000)

  it('leaves the undo history alone when the pass converges without writing', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', 'not a number')
    const errors: ProcessorRejection[] = []
    repo.onUserError(err => { errors.push(err) })
    const before = undoDepth(repo)
    expect(before).toBeGreaterThan(0)

    // Every value is unconvertible, so the cell converges on the bag it already
    // holds and no row is rewritten. There is nothing for an undo entry to be
    // replayed over, and costing the user their history anyway is the
    // over-approximation worth not having.
    await republish(repo, statusNumber)

    expect(rejectionsWithCode(errors, UNCONVERTIBLE)).toHaveLength(1)
    expect(undoDepth(repo)).toBe(before)
    expect(rejectionsWithCode(errors, UNDO_CLEARED)).toHaveLength(0)
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
    expect(rejectionsWithCode(errors, UNCONVERTIBLE)).toHaveLength(1)
    expect(rejectionsWithCode(errors, UNCONVERTIBLE)[0]!.meta).toMatchObject({count: 1})

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

describe('codec changes observed only across a workspace switch (#780)', () => {
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
   *  `repo.tx` runs on this device. Waiting for OTHER_WS to prime makes it a
   *  real workspace visit (which is what rotates the resolver's previous slot);
   *  it does NOT make the return a cross-workspace diff — pinning WS rebuilds
   *  once with a null registry before its projector primes, so `previous` is
   *  null at the prime either way. */
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

  it('re-encodes a codec change that synced in while the workspace was OPEN, at the next prime', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()

    // Synced in while WS is ACTIVE. The bridge's own in-memory diff schedules
    // this one, so it applies immediately — the point of the test is what the
    // baseline does NOT do: absorb it before the pass has run.
    publishDefinition(repo, statusNumber)
    await awaitRegistry(repo, WS, 'status')
    await vi.waitFor(async () => {
      expect(await cell('p')).toEqual({status: 42})
    }, {timeout: 5000})
    await repo.awaitPropertyDefinitionBaselines()

    // Rebuilds keep happening — a plugin finishing load, another definition
    // arriving. Each one's in-memory previous already carries the new codec, so
    // none sees a change; the baseline must reflect what was APPLIED, not
    // whichever build happened to observe it.
    for (let build = 0; build < 2; build += 1) {
      publishDefinition(repo, statusNumber)
      await repo.awaitPropertyDefinitionBaselines()
    }
    const scheduled = vi.spyOn(repo, 'schedulePropertyDefinitionMigrations')

    repo.setActiveWorkspaceId(OTHER_WS)
    await awaitRegistry(repo, OTHER_WS)
    repo.setActiveWorkspaceId(WS)
    await awaitRegistry(repo, WS)
    await repo.awaitPropertyDefinitionBaselines()

    expect(scheduled).not.toHaveBeenCalled()
  }, 20_000)

  it('re-checks the baseline when a codec becomes resolvable after the prime', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()

    // The change lands while the workspace is inactive AND its preset is still
    // loading, so the prime sees the definition metadata-only. Nothing can be
    // diffed yet — a codec this device never observed is not drift.
    repo.setActiveWorkspaceId(OTHER_WS)
    await awaitRegistry(repo, OTHER_WS)
    publishDefinitionWithoutSchema(repo, 'status')
    repo.setActiveWorkspaceId(WS)
    await awaitRegistry(repo, WS)
    await repo.awaitPropertyDefinitionBaselines()
    expect(await cell('p')).toEqual({status: ' 42 '})

    // The preset finishes loading on a LATER rebuild. The in-memory diff reads
    // that as no change (it needs a codec on both sides), so without the
    // baseline re-check the drift would never be acted on this session — or any
    // session, if the preset always loads after the prime.
    publishDefinition(repo, statusNumber)

    await vi.waitFor(async () => {
      expect(await cell('p')).toEqual({status: 42})
    }, {timeout: 5000})
    expect(await rowContent(valueRowId)).toBe('42')
  }, 20_000)

  it('records nothing when the batch throws, so the next prime retries', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    // Recording sits AFTER the batch inside its try for exactly this reason:
    // above it, a pass that died mid-way would be recorded as applied and the
    // drift would never be re-detected.
    const batch = vi.spyOn(
      repo as unknown as {runPropertyDefinitionMigrationBatch: () => Promise<void>},
      'runPropertyDefinitionMigrationBatch',
    ).mockRejectedValue(new Error('[test] batch failed'))

    await changeWhileInactive(repo, statusNumber)
    await vi.waitFor(() => {
      expect(batch).toHaveBeenCalled()
    }, {timeout: 5000})

    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
    batch.mockRestore()
  }, 20_000)

  it('records nothing in an UN-FLIPPED workspace, so the flip repairs it', async () => {
    // The flip gate returns before the batch, and therefore before the record.
    // Absorbing the drift here would leave a 'cell' workspace's codec change
    // permanently invisible to the prime that follows its flip.
    await seedWorkspace('cell')
    const repo = setup()
    await repo.tx(async tx => {
      await tx.create({
        id: 'p', workspaceId: WS, parentId: null, orderKey: 'k-p', content: 'host',
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', statusString, ' 42 '),
      {scope: ChangeScope.BlockDefault})
    await repo.awaitPropertyDefinitionBaselines()

    await changeWhileInactive(repo, statusNumber)
    await vi.waitFor(async () => {
      await repo.awaitPropertyDefinitionMigrations()
      expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
    }, {timeout: 5000})
  }, 20_000)

  it('records a baseline even while the repo is read-only', async () => {
    await seedWorkspace('children')
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    // `App` pins the workspace BEFORE it resolves the role, so a prime
    // routinely lands while this is still true. Gating the RECORD on it would
    // leave the device with no baseline and no second prime — blind for the
    // rest of the session, and starting the next one with nothing.
    repo.setReadOnly(true)
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    await awaitRegistry(repo, WS, 'status')
    await repo.awaitPropertyDefinitionBaselines()

    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
  }, 20_000)

  it('with NO recorded baseline, records one and migrates nothing', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    // A device that has never recorded a baseline for this workspace — a fresh
    // install, or one whose `client_schema_state` was wiped. The drive below is
    // the SAME as the first test in this block, which DOES migrate; the only
    // difference is the missing before-state.
    await sharedDb.db.execute(
      `DELETE FROM client_schema_state WHERE key LIKE '${PROPERTY_DEFINITION_BASELINE_PREFIX}%'`,
    )
    const scheduled = vi.spyOn(repo, 'schedulePropertyDefinitionMigrations')

    await changeWhileInactive(repo, statusNumber)

    // Not "everything changed": nothing is scheduled at all and the value is
    // left alone. The baseline IS recorded, so the NEXT drift is detected.
    expect(scheduled).not.toHaveBeenCalled()
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'number'})
  }, 20_000)

  it('refuses to write into a workspace the session has switched away from', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    publishDefinition(repo, statusNumber)
    await awaitRegistry(repo, WS, 'status')
    // Captured the way the baseline path captures it: synchronously with the
    // rebuild, BEFORE its async read of the stored baseline.
    const snapshot = rebuildSnapshot(repo)

    for (const workspaceId of [OTHER_WS, THIRD_WS]) {
      repo.setActiveWorkspaceId(workspaceId)
      await awaitRegistry(repo, workspaceId)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    repo.schedulePropertyDefinitionMigrations(
      WS, [{fieldId: FIELD_ID, oldName: 'status', newName: 'status', codecChanged: true}], snapshot,
    )

    // The pass RAN and refused — asserted on the refusal, not on the absence of
    // a write, which a pass whose deferral timer had simply not fired yet would
    // also satisfy.
    await vi.waitFor(() => {
      expect(warn.mock.calls.flat().join(' ')).toContain('is no longer active')
    }, {timeout: 5000})
    warn.mockRestore()

    // `repo.tx` pins to whatever workspace is active, so a write here would
    // land WS's rows under THIRD_WS's access state and undo stack — and the
    // read-only gate would be answering for the wrong workspace's role.
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await rowContent(valueRowId)).toBe(' 42 ')
  }, 20_000)

  it('refuses a pass scheduled during an EARLIER visit to the same workspace', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', ' 42 ')
    // Drained to completion first, so the baseline already records `number`.
    // The round trip below then primes against a registry it agrees with and
    // schedules nothing of its own — otherwise ITS refusal, from a genuinely
    // stale visit, satisfies the assertion and the pairing under test is
    // never exercised.
    await republish(repo, statusNumber)
    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'number'})
    const snapshot = rebuildSnapshot(repo)

    // Away and back BEFORE scheduling, carrying the first visit's snapshot —
    // the shape the baseline path has, since it computes its changes in an
    // async continuation of the rebuild and schedules from there. The workspace
    // id is restored, so identity alone reads as "still here"; only the
    // generation says these plans belong to a visit that has ended. Sampling
    // the generation at scheduling time instead would certify them as current.
    repo.setActiveWorkspaceId(OTHER_WS)
    await awaitRegistry(repo, OTHER_WS)
    repo.setActiveWorkspaceId(WS)
    await awaitRegistry(repo, WS, 'status')
    await repo.awaitPropertyDefinitionBaselines()
    await repo.awaitPropertyDefinitionMigrations()

    // Installed only now, so the single refusal it can see is the one below.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    repo.schedulePropertyDefinitionMigrations(
      WS, [{fieldId: FIELD_ID, oldName: 'status', newName: 'status', codecChanged: true}], snapshot,
    )
    await vi.runAllTimersAsync()
    await repo.awaitPropertyDefinitionMigrations()
    vi.useRealTimers()

    expect(warn.mock.calls.flat().join(' ')).toContain('was re-opened')
    warn.mockRestore()
  }, 20_000)

  it('clears the undo history after EVERY writing chunk, and tells the user once', async () => {
    // A user edit made BETWEEN two chunks lands an undo entry whose `before`
    // snapshot holds the OLD encoding of a row the later chunk has not reached
    // yet. Replaying it reverts that row's migration — permanently, since the
    // baseline records the pass as applied — so clearing on the first write
    // alone leaves the window open for as long as the pass runs. Measured at
    // ~3s; budgeted for the ~6x the full suite's contention adds.
    await seedWorkspace('children')
    const repo = setup()
    const hostIds = Array.from({length: 101}, (_, i) => `host-${String(i).padStart(3, '0')}`)
    await repo.tx(async tx => {
      for (const id of hostIds) {
        await tx.create({id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content: 'host'})
      }
    }, {scope: ChangeScope.BlockDefault})
    for (const id of hostIds) {
      await repo.tx(tx => tx.setProperty(id, statusString, ' 42 '),
        {scope: ChangeScope.BlockDefault})
    }
    await repo.awaitPropertyDefinitionBaselines()
    const cleared = vi.spyOn(repo.undoManagerFor(WS), 'clear')
    const errors: ProcessorRejection[] = []
    repo.onUserError(err => { errors.push(err) })

    await changeWhileInactive(repo, statusNumber)

    // Fenced on the CLEAR, not on a row the second chunk wrote: the clear runs
    // after that chunk's transaction commits, so a wait on the row can return
    // between the two and read a count of one.
    await vi.waitFor(() => {
      expect(cleared).toHaveBeenCalledTimes(2)
    }, {timeout: 10_000})
    expect(await cell('host-100')).toEqual({status: 42})
    // Told once, though. The history is gone either way and repeating it per
    // chunk is noise.
    expect(rejectionsWithCode(errors, UNDO_CLEARED)).toHaveLength(1)
  }, 30_000)

  it('clears the undo history even when an intervening edit makes the later chunk converge', async () => {
    // The gap the per-chunk rule left open. A user edit to a not-yet-processed
    // row CANONICALIZES it — `setProperty` writes under the live schema — so
    // the chunk that reaches that row converges and writes nothing, while the
    // entry that edit left behind still holds the row's pre-edit, old-codec
    // snapshot. Replaying it reverts that row with the baseline already
    // recorded. Measured at ~3s; budgeted for the ~6x the suite's contention adds.
    await seedWorkspace('children')
    const repo = setup()
    const hostIds = Array.from({length: 101}, (_, i) => `host-${String(i).padStart(3, '0')}`)
    await repo.tx(async tx => {
      for (const id of hostIds) {
        await tx.create({id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content: 'host'})
      }
    }, {scope: ChangeScope.BlockDefault})
    for (const id of hostIds) {
      await repo.tx(tx => tx.setProperty(id, statusString, ' 42 '),
        {scope: ChangeScope.BlockDefault})
    }
    await repo.awaitPropertyDefinitionBaselines()

    // The edit lands after the first chunk has committed and before the second
    // runs, on a row the second chunk owns — fenced on the pass's own "a chunk
    // committed" signal rather than a timer.
    let edited: Promise<unknown> | null = null
    repo.onUserError(err => {
      if (err.code !== UNDO_CLEARED || edited !== null) return
      // `as never` for the same reason `schemaWith` uses it: the test schemas
      // are all declared through the string overload, so a number value needs
      // the cast even where the codec is the number one.
      edited = repo.tx(tx => tx.setProperty('host-100', statusNumber, 99 as never),
        {scope: ChangeScope.BlockDefault})
    })

    await changeWhileInactive(repo, statusNumber)
    await vi.waitFor(() => { expect(edited).not.toBeNull() }, {timeout: 8000})
    await edited
    await repo.awaitPropertyDefinitionMigrations()

    // The second chunk finds host-100 already canonical and writes nothing, so
    // a per-chunk rule would have preserved the user's entry. The sticky one
    // does not.
    await vi.waitFor(() => { expect(undoDepth(repo)).toBe(0) }, {timeout: 8000})
  }, 30_000)

  it('retries once the device catches up, rather than waiting for the next prime', async () => {
    // "The next prime" is a workspace switch or a reload, not the passage of
    // time — so a transient gap at session start, which is exactly when the
    // prime that detects drift happens, would otherwise leave the session
    // running the new codec against rows still in the old one.
    await seedWorkspace('children')
    let openGate: (() => void) | null = null
    let settled = false
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: (cb) => {
        if (settled) { cb(); return () => {} }
        openGate = cb
        return () => { openGate = null }
      },
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()

    await changeWhileInactive(repo, statusNumber)
    await vi.waitFor(() => { expect(openGate).not.toBeNull() }, {timeout: 5000})
    // Refused so far, and nothing recorded — the drift is still this device's
    // to repair.
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})

    settled = true
    openGate!()

    // The baseline is the pass's LAST write; waiting on the cell instead can
    // return between the chunk commit and the record.
    await vi.waitFor(async () => {
      expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'number'})
    }, {timeout: 10_000})
    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  }, 30_000)

  it('keeps retrying while the gap stays transient, past the gate opening', async () => {
    // The gate answers connected-and-not-downloading; the materialization
    // drain settles separately. A single retry lands in that window and gives
    // up, leaving the session running the new codec against old encodings.
    await seedWorkspace('children')
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: (cb) => { cb(); return () => {} },
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    // Open gate, staged rows still draining — for several attempts.
    let gapsLeft = 4
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => {
      if (gapsLeft <= 0) return null
      gapsLeft -= 1
      return {reason: 'synced rows are still draining into `blocks`', transient: true}
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await changeWhileInactive(repo, statusNumber)

    // Waited on the BASELINE, which the pass records after its last chunk
    // commits — so a wait on the cell can return between the two, and the
    // baseline read that follows is then early. (CI caught exactly that.)
    await vi.waitFor(async () => {
      expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'number'})
    }, {timeout: 10_000})
    warn.mockRestore()
    expect(await cell('p')).toEqual({status: 42})
    expect(await rowContent(valueRowId)).toBe('42')
  }, 30_000)

  it('does not retry a DURABLE gap, which nothing is working to clear', async () => {
    await seedWorkspace('children')
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: (cb) => { cb(); return () => {} },
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    // Rows this device downloaded and could not apply. Waiting never clears
    // it, so re-arming on the gate would spin for the rest of the session.
    vi.spyOn(repo, 'workspaceViewGap').mockResolvedValue({
      reason: '3 synced row(s) have not reached `blocks` on this device',
      transient: false,
    })
    const runs = vi.spyOn(
      repo as unknown as {runPropertyDefinitionMigrations: () => Promise<void>},
      'runPropertyDefinitionMigrations',
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await changeWhileInactive(repo, statusNumber)
    await vi.waitFor(() => { expect(runs.mock.calls.length).toBeGreaterThanOrEqual(1) }, {timeout: 5000})
    await repo.awaitPropertyDefinitionMigrations()
    await repo.awaitPropertyDefinitionMigrations()
    warn.mockRestore()

    expect(runs.mock.calls.length).toBe(1)
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
  }, 20_000)

  it('retries the DETECTION, so a change superseded while parked is not resurrected', async () => {
    // The hazard a parked PLAN has: the same definition changes again while the
    // retry waits, and a registry rebuild does not move the workspace
    // generation — so the superseded plan passes every freshness check and
    // re-encodes the rows, and the baseline, to the intermediate codec.
    await seedWorkspace('children')
    let gapped = true
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: (cb) => { cb(); return () => {} },
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () =>
      (gapped ? {reason: 'synced rows are still draining into `blocks`', transient: true} : null))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // string -> number is detected and refused, so a retry is parked.
    await changeWhileInactive(repo, statusNumber)
    await vi.waitFor(() => {
      expect(warn.mock.calls.flat().join(' ')).toContain('Re-detecting')
    }, {timeout: 5000})

    // ...and then the definition goes BACK to string while the retry waits.
    // Re-detection reads the live registry, which now agrees with the
    // baseline, so there is nothing to migrate. Replaying the parked plans
    // would re-encode to the number codec the workspace no longer uses.
    publishDefinition(repo, statusString)
    await awaitRegistry(repo, WS, 'status')
    gapped = false
    await vi.waitFor(async () => {
      await repo.awaitPropertyDefinitionMigrations()
      await repo.awaitPropertyDefinitionBaselines()
      expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
    }, {timeout: 8000})
    warn.mockRestore()

    expect(await rowContent(valueRowId)).toBe(' 42 ')
    expect(await cell('p')).toEqual({status: ' 42 '})
  }, 20_000)

  it('drops a parked re-detect whose workspace the session has since left', async () => {
    // The listener outlives the switch on purpose — a switch between the gate
    // FIRING and the deep-idle job running is past anything a switch handler
    // could dispose. What holds this up is the write-time staleness check, not
    // the re-detect's own identity guard (which is defence in depth and fails
    // nothing when deleted): the re-detect may well diff the wrong registry,
    // and the pass it schedules is refused before it can write.
    await seedWorkspace('children')
    let openGate: (() => void) | null = null
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: (cb) => { openGate = cb; return () => { openGate = null } },
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await changeWhileInactive(repo, statusNumber)
    await vi.waitFor(() => { expect(openGate).not.toBeNull() }, {timeout: 5000})

    // The session moves to another workspace, whose registry answers to the
    // SAME fieldId at a different codec — the shape that makes a cross-workspace
    // fold visible rather than a silent no-op.
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-status-definition-other',
      [{
        metadata: {
          fieldId: FIELD_ID, workspaceId: OTHER_WS, createdAt: 1, name: 'status',
          changeScope: ChangeScope.BlockDefault, hidden: false, origin: 'user' as const,
        },
        schema: statusNumber,
      }],
      {workspaceId: OTHER_WS},
    )
    repo.setActiveWorkspaceId(OTHER_WS)
    await awaitRegistry(repo, OTHER_WS)

    // Fenced on the re-detect actually RUNNING. Draining and then asserting
    // that nothing changed passes trivially if the deferred job has not fired
    // yet, which is the whole failure mode a negative test has.
    const redetected = vi.spyOn(
      repo as unknown as {redetectPropertyDefinitionDrift: () => void},
      'redetectPropertyDefinitionDrift',
    )
    openGate!()
    await vi.waitFor(() => { expect(redetected).toHaveBeenCalled() }, {timeout: 8000})
    await repo.awaitPropertyDefinitionMigrations()
    await repo.awaitPropertyDefinitionBaselines()
    warn.mockRestore()

    expect(await rowContent(valueRowId)).toBe(' 42 ')
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
  }, 20_000)

  it('runs two rebuilds of one definition in order, never interleaved', async () => {
    // `string -> number -> string` inside one deferral window: both rebuilds
    // capture their own plans under the SAME workspace generation, because a
    // rebuild does not move it. Run independently, the smaller pass finishes
    // first and the older one then re-encodes the rows and records the
    // intermediate codec as the baseline.
    await seedWorkspace('children')
    const repo = setup()
    await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()

    const order: string[] = []
    let release: (() => void) | null = null
    let calls = 0
    const batch = vi.spyOn(
      repo as unknown as {runPropertyDefinitionMigrationBatch: () => Promise<boolean>},
      'runPropertyDefinitionMigrationBatch',
    ).mockImplementation(async () => {
      calls += 1
      const nth = calls
      order.push(`enter${nth}`)
      // The first pass is still in flight when the second's timer fires, which
      // is the whole window the race lives in.
      if (nth === 1) await new Promise<void>(resolve => { release = () => resolve() })
      order.push(`exit${nth}`)
      return false
    })

    vi.useFakeTimers()
    const snapshot = rebuildSnapshot(repo)
    repo.schedulePropertyDefinitionMigrations(
      WS, [{fieldId: FIELD_ID, oldName: 'status', newName: 'status', codecChanged: true}], snapshot,
    )
    repo.schedulePropertyDefinitionMigrations(
      WS, [{fieldId: FIELD_ID, oldName: 'status', newName: 'status', codecChanged: true}], snapshot,
    )
    await vi.runAllTimersAsync()
    vi.useRealTimers()

    await vi.waitFor(() => { expect(order).toContain('enter1') }, {timeout: 5000})
    // A real window before asserting the absence, because there is no positive
    // signal to fence on: unserialized, the second pass reaches the batch only
    // after its own DB reads, so releasing immediately would let it run second
    // for the wrong reason and the test would pass with the chain deleted.
    for (let turn = 0; turn < 40; turn += 1) {
      await new Promise(resolve => { setTimeout(resolve, 5) })
      if (order.includes('enter2')) break
    }
    expect(order).not.toContain('enter2')
    release!()
    await repo.awaitPropertyDefinitionMigrations()
    batch.mockRestore()

    expect(order).toEqual(['enter1', 'exit1', 'enter2', 'exit2'])
  }, 20_000)

  it('parks ONE re-detect per workspace, however many passes the gap refuses', async () => {
    // One gap refuses every definition that primes during it. A listener each
    // would all fire before any of their passes records, re-detect against the
    // same unchanged baseline, and enqueue that many full-workspace passes.
    await seedWorkspace('children')
    // A PARK is a gate call whose disposer is not invoked synchronously;
    // `backfillSyncSettledNow` samples the very same gate and disposes at once,
    // so counting calls would count those too.
    let openGate: (() => void) | null = null
    let parks = 0
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: (cb) => {
        let disposed = false
        queueMicrotask(() => { if (!disposed) { parks += 1; openGate = cb } })
        return () => { disposed = true; if (openGate === cb) openGate = null }
      },
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Two refusals in the same gap: each workspace round trip primes and
    // re-detects the drift the previous one could not record.
    await changeWhileInactive(repo, statusNumber)
    await vi.waitFor(() => { expect(parks).toBe(1) }, {timeout: 5000})
    await changeWhileInactive(repo, statusNumber)
    await repo.awaitPropertyDefinitionMigrations()
    await new Promise(resolve => queueMicrotask(() => resolve(null)))
    warn.mockRestore()

    // The second refusal found a re-detect already waiting and added nothing.
    expect(parks).toBe(1)
  }, 20_000)

  it('re-checks the workspace after the gap probe awaits', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    publishDefinition(repo, statusNumber)
    await awaitRegistry(repo, WS, 'status')
    const snapshot = rebuildSnapshot(repo)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The gap probe reads the DB, so it yields — and `setActiveWorkspaceId` is
    // a synchronous field write that lands cleanly in that window. Checking
    // identity only BEFORE the probe leaves the pass writing one workspace's
    // rows under another's access state.
    // Every probe this pass makes now comes from inside a writing transaction
    // or from the check before the record, so switching on any of them lands
    // in the window that matters: the gap probe has already yielded, and a
    // staleness check placed ahead of it would have passed.
    const gap = vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => {
      repo.setActiveWorkspaceId(OTHER_WS)
      return null
    })

    repo.schedulePropertyDefinitionMigrations(
      WS, [{fieldId: FIELD_ID, oldName: 'status', newName: 'status', codecChanged: true}], snapshot,
    )

    await vi.waitFor(() => {
      expect(warn.mock.calls.flat().join(' ')).toContain('is no longer active')
    }, {timeout: 5000})
    warn.mockRestore()
    gap.mockRestore()

    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await rowContent(valueRowId)).toBe(' 42 ')
  }, 20_000)

  it('stops mid-pass when the view gaps between chunks', async () => {
    // The doctrine's actual rule, and the one position a pre-run check can
    // never cover: the batch chunks at 100 parents and a big pass writes over
    // minutes, so the device can fall behind the server between chunk 1 and
    // chunk 50. Measured at ~3s; budgeted for the ~6x stretch the full suite's
    // one-worker-per-core contention adds.
    await seedWorkspace('children')
    let settled = true
    const {repo} = createTestRepo({
      db: sharedDb.db, user: {id: 'user-1'},
      backfillSyncGate: (cb) => { if (settled) cb(); return () => {} },
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)

    // 101 parents: one full chunk plus a remainder. Created in two transactions
    // rather than 101 — the pass reads rows, not tx boundaries.
    const hostIds = Array.from({length: 101}, (_, i) => `host-${String(i).padStart(3, '0')}`)
    await repo.tx(async tx => {
      for (const id of hostIds) {
        await tx.create({id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content: 'host'})
      }
    }, {scope: ChangeScope.BlockDefault})
    for (const id of hostIds) {
      await repo.tx(tx => tx.setProperty(id, statusString, ' 42 '),
        {scope: ChangeScope.BlockDefault})
    }
    await repo.awaitPropertyDefinitionBaselines()

    // Fenced on the pass's own "a chunk COMMITTED" signal rather than a timer
    // or a sample count: the undo clear fires immediately after the first
    // chunk's transaction resolves, which is exactly the boundary this test
    // needs to fall behind on.
    repo.onUserError(err => { if (err.code === UNDO_CLEARED) settled = false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await changeWhileInactive(repo, statusNumber)

    await vi.waitFor(() => {
      expect(warn.mock.calls.flat().join(' ')).toContain('not caught up with the server')
    }, {timeout: 5000})
    warn.mockRestore()

    // The first chunk landed and the second refused: a partially applied pass,
    // which is fine because every row is convergent and nothing was recorded.
    const migrated = await sharedDb.db.get<{n: number}>(
      `SELECT COUNT(*) AS n FROM blocks
        WHERE workspace_id = ? AND json_extract(properties_json, '$.status') = 42`,
      [WS],
    )
    expect(migrated.n).toBe(100)
    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
  }, 30_000)

  it('records nothing when the view gaps while the batch is running', async () => {
    await seedWorkspace('children')
    let settled = true
    const {repo} = createTestRepo({
      db: sharedDb.db, user: {id: 'user-1'},
      backfillSyncGate: (cb) => { if (settled) cb(); return () => {} },
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Stands in for a long chunked run that commits nothing: the device falls
    // behind the server while the batch is in flight. The check before the SCAN
    // ran while it was still caught up, and a batch that wrote no chunk opened
    // no transaction to re-check inside — so the check before the RECORD is the
    // only thing between a half-seen graph and a drift marked applied forever.
    const batch = vi.spyOn(
      repo as unknown as {runPropertyDefinitionMigrationBatch: () => Promise<void>},
      'runPropertyDefinitionMigrationBatch',
    ).mockImplementation(async () => { settled = false })

    await changeWhileInactive(repo, statusNumber)

    // Waited on the REFUSAL, which is strictly after the point the record would
    // have been written — reading the baseline on `batch` having been called
    // would pass before the record had a chance to happen.
    await vi.waitFor(() => {
      expect(warn.mock.calls.flat().join(' ')).toContain('not caught up with the server')
    }, {timeout: 5000})
    warn.mockRestore()
    batch.mockRestore()

    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
  }, 20_000)

  it('aborts when the role turns read-only inside the deferral window', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    publishDefinition(repo, statusNumber)
    await awaitRegistry(repo, WS, 'status')
    const snapshot = rebuildSnapshot(repo)
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The schedule-time `isReadOnly` check cannot cover this: the role arrives
    // from the server asynchronously and the batch runs on deep idle, so a pass
    // scheduled while this device was an editor routinely runs after it has
    // stopped being one. What catches it is the commit pipeline's own gate,
    // re-sampled per transaction — `References` is a rejected scope in
    // read-only, so the chunk throws before `fn` reads a row. Nothing here
    // restates that check, which is why this test exists to pin it.
    vi.useFakeTimers()
    repo.schedulePropertyDefinitionMigrations(
      WS, [{fieldId: FIELD_ID, oldName: 'status', newName: 'status', codecChanged: true}], snapshot,
    )
    repo.setReadOnly(true)
    await vi.runAllTimersAsync()
    await repo.awaitPropertyDefinitionMigrations()
    vi.useRealTimers()

    expect(failure.mock.calls.flat().join(' ')).toContain('rejected in read-only mode')
    failure.mockRestore()
    repo.setReadOnly(false)
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await rowContent(valueRowId)).toBe(' 42 ')
  }, 20_000)

  it('writes nothing and records nothing while this device is behind the server', async () => {
    await seedWorkspace('children')
    // A gate that never fires its callback is exactly how
    // `backfillSyncSettledNow` reads "still downloading, disconnected, or a
    // download error".
    const {repo} = createTestRepo({
      db: sharedDb.db, user: {id: 'user-1'}, backfillSyncGate: () => () => {},
    })
    repo.setActiveWorkspaceId(WS)
    publishDefinition(repo, statusString)
    const {valueRowId} = await seedProperty(repo, 'p', ' 42 ')
    await repo.awaitPropertyDefinitionBaselines()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await changeWhileInactive(repo, statusNumber)

    await vi.waitFor(() => {
      expect(warn.mock.calls.flat().join(' ')).toContain('not caught up with the server')
    }, {timeout: 5000})
    warn.mockRestore()

    // The whole hazard in one pair. Re-encoding from here uploads a properties
    // bag built from rows this device has not caught up on, overwriting edits
    // it has never seen; recording it would hide the drift from every later
    // prime. The baseline still holds the OLD codec, so the next prime retries.
    expect(await cell('p')).toEqual({status: ' 42 '})
    expect(await rowContent(valueRowId)).toBe(' 42 ')
    expect(await baselineCodecs()).toEqual({[FIELD_ID]: 'string'})
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
    expect(await liveRows('host', F_OWNER)).toBe(2)
    expect(await cell('host')).toEqual({
      a: `v-${F_RENAMED}`, zz: `v-${F_OWNER}`, r: `v-${F_PLAIN}`,
    })
  }, 20_000)
})
