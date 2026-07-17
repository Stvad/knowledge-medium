// @vitest-environment node
/**
 * Slice B2 (PR #288 §7/§9): rename-reproject + codec-change re-encode.
 * A definition rename or codec change under a durable fieldId triggers a
 * child-indexed migration pass — field-row retitle ([[old]] → [[new]]),
 * cell re-key, value re-encode, with unconvertible values reported — all
 * flip-gated (dormant in a 'cell' workspace).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty, ProcessorRejection } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import { changedPropertyDefinitions } from './internals/propertyDefinitionMigrations'
import type { Repo } from './repo'

const WS = 'ws-def-migrations'
const FIELD_ID = 'field-status-migrations'

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
const stateString = schemaWith('state')
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

describe('changedPropertyDefinitions (diff)', () => {
  it('never diffs across workspaces', () => {
    const metadata = (workspaceId: string) => ({
      workspaceId,
      schemas: new Map(),
      definitionsByFieldId: new Map([[FIELD_ID, {
        fieldId: FIELD_ID, workspaceId, createdAt: 1, name: 'a',
        changeScope: ChangeScope.BlockDefault, hidden: false, origin: 'user' as const,
      }]]),
      definitionsByName: new Map(),
      schemasByFieldId: new Map(),
      seedsByKey: new Map(),
      seedsByName: new Map(),
    })
    const prev = metadata('ws-a')
    const next = {...metadata('ws-b')}
    next.definitionsByFieldId.get(FIELD_ID)!
    expect(changedPropertyDefinitions(prev as never, next as never)).toEqual([])
  })
})

describe('rename migration (flipped workspace)', () => {
  it('re-keys consuming cells; field-row content is id-stable across the rename', async () => {
    await seedWorkspace('children')
    const repo = setup()
    const {fieldRowId, valueRowId} = await seedProperty(repo, 'p', 'done')
    expect(await cell('p')).toEqual({status: 'done'})

    await republish(repo, stateString)

    // Field rows address the definition BY ID (`((fieldId))`, §7), so a rename
    // never retitles their content — only the name-keyed cell re-keys.
    expect(await rowContent(fieldRowId)).toBe(`((${FIELD_ID}))`)
    expect(await cell('p')).toEqual({state: 'done'})
    expect(await rowContent(valueRowId)).toBe('done')
  })

  it('is dormant in an un-flipped workspace', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await repo.tx(async tx => {
      await tx.create({
        id: 'p', workspaceId: WS, parentId: null, orderKey: 'k', content: 'host',
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', statusString, 'done'),
      {scope: ChangeScope.BlockDefault})

    await republish(repo, stateString)

    // Cell keeps the old key (today's rename semantics), no children exist.
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
    expect(await rowContent(fieldRowId)).toBe(`((${FIELD_ID}))`)
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
  // The swapped pair: the SAME fieldIds now carry each other's old names.
  const alphaRenamedToBeta = schemaWith('beta')
  const betaRenamedToAlpha = schemaWith('alpha')

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

    // The swap, in ONE rebuild.
    vi.useFakeTimers()
    publishPair(repo, alphaRenamedToBeta, betaRenamedToAlpha)
    await vi.runAllTimersAsync()
    await repo.awaitPropertyDefinitionMigrations()
    vi.useRealTimers()

    // Each definition's value follows ITS fieldId to its new name — nothing is
    // clobbered by the other pass, and neither field row is tombstoned by the
    // materializer reading a re-key as a user delete.
    expect(await cell('host')).toEqual({beta: 'alpha-value', alpha: 'beta-value'})
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
})
