// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { propertyDefinitionBlockId } from '@/data/definitionSeeds'
import {
  beginPropertyDefinitionFanout,
  markPropertyDefinitionFanoutRunning,
  propertyDefinitionFanout,
} from '@/data/propertyDefinitionFanout'
import {
  aliasesProp,
  presetIdProp,
  propertyChangeScopeProp,
  propertyDefaultProp,
  propertyNameProp,
  typesProp,
} from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { annotationsDataExtension } from '@/plugins/annotations/dataExtension'
import { createThread } from '@/plugins/annotations/threads'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension'
import { referencesDataExtension } from '@/plugins/references/dataExtension'
import { dailyNoteBlockId, getOrCreateDailyNote } from '../dailyNotes'
import { dailyNotesDataExtension } from '../dataExtension'
import { setDayProperty } from '../dayProperty'
import { DAILY_NOTE_TYPE, dailyNoteDateProp } from '../schema'

const WS = 'date-conversion-workspace'
const USER = {id: 'test-user'}
const DEFINITION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const NAME = 'test:appointment-date'
const SCOPE = {scope: ChangeScope.BlockDefault}
const EXISTING_DAY = '2026-02-02'
const NEW_DAY = '2026-02-03'
const DEFAULT_DAY = '2026-02-04'
const midnight = (day: string) => `${day}T00:00:00.000Z`

let testDb: TestDb
beforeAll(async () => { testDb = await createTestDb() })
afterAll(async () => { await testDb.cleanup() })
beforeEach(async () => { await resetTestDb(testDb.db) })

const setup = async (mode: 'cell' | 'children', defaultValue?: string) => {
  await testDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test workspace', ?, 1, 1, 'none', NULL, ?)`,
    [WS, USER.id, mode],
  )
  const {repo} = createTestRepo({
    db: testDb.db,
    user: USER,
    extensions: [dailyNotesDataExtension, referencesDataExtension, backlinksDataExtension, annotationsDataExtension],
  })
  repo.setActiveWorkspaceId(WS)
  await repo.tx(tx => tx.create({
    id: DEFINITION, workspaceId: WS, parentId: null, orderKey: 'definition',
    content: NAME,
    properties: {
      [typesProp.name]: [PROPERTY_SCHEMA_TYPE],
      [propertyNameProp.name]: NAME,
      [propertyChangeScopeProp.name]: ChangeScope.BlockDefault,
      [presetIdProp.name]: 'date',
      ...(defaultValue === undefined ? {} : {[propertyDefaultProp.name]: defaultValue}),
    },
  }), SCOPE)
  await vi.waitFor(() => expect(repo.propertySchemas.get(NAME)?.codec.type).toBe('date'), {timeout: 3000})
  return repo
}

const createOwners = (repo: Repo, dates: Record<string, string | null | undefined>) => repo.tx(async tx => {
  const schema = repo.propertySchemas.get(NAME)!
  for (const [id, date] of Object.entries(dates)) {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: id, content: id})
    if (date !== undefined) {
      await tx.setProperty(id, schema, date === null ? undefined : new Date(date))
    }
  }
}, SCOPE)

const retype = (repo: Repo) => repo.tx(tx => tx.setProperty(DEFINITION, presetIdProp, 'day'), SCOPE)

const readValueChild = (owner: string, definition = DEFINITION) => testDb.db.getOptional<{id: string; parent_id: string; content: string; reference_target_id: string | null}>(
  `SELECT value.id, value.parent_id, value.content, value.reference_target_id
     FROM blocks value JOIN blocks field ON value.parent_id = field.id
    WHERE field.parent_id = ? AND field.reference_target_id = ?
      AND value.deleted = 0 AND field.deleted = 0`,
  [owner, definition],
)

const storedProperties = async (id: string): Promise<Record<string, unknown>> => {
  const row = await testDb.db.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [id])
  return JSON.parse(row.properties_json) as Record<string, unknown>
}

const expectNote = async (repo: Repo, day: string) => {
  const id = dailyNoteBlockId(WS, day)
  const note = await repo.load(id)
  expect(note?.properties).toMatchObject({
    [aliasesProp.name]: expect.arrayContaining([day]),
    [typesProp.name]: expect.arrayContaining([DAILY_NOTE_TYPE]),
    [dailyNoteDateProp.name]: midnight(day),
  })
  return id
}

const backlinks = (repo: Repo, id: string) =>
  repo.query['backlinks.forBlock']({workspaceId: WS, id}).load()

const expectBacklinksFrom = async (repo: Repo, target: string, owners: string[]) => {
  const ownerByChild = new Map<string, string>()
  for (const owner of owners) {
    const child = await readValueChild(owner)
    if (child) ownerByChild.set(child.id, owner)
  }
  const sources = await backlinks(repo, target)
  expect(sources.map(source => ownerByChild.get(source) ?? source).sort()).toEqual(owners.toSorted())
}

const propertyBacklinks = async (id: string, property = NAME) => {
  const rows = await testDb.db.getAll<{source_id: string}>(
    'SELECT source_id FROM block_references WHERE target_id = ? AND source_field = ? ORDER BY source_id',
    [id, property],
  )
  return rows.map(row => row.source_id)
}

// Undo preserves the stored graph while recording new timestamps and tombstones.
const liveGraph = () => testDb.db.getAll(
  `SELECT id, parent_id, content, order_key, properties_json, references_json, reference_target_id, is_field_form
     FROM blocks WHERE workspace_id = ? AND deleted = 0 ORDER BY id`,
  [WS],
)

const workspaceRows = () => testDb.db.getAll(
  'SELECT * FROM blocks WHERE workspace_id = ? ORDER BY id', [WS],
)

describe.each(['cell', 'children'] as const)('date to day in %s storage', mode => {
  it('preserves owner values and annotations through conversion, undo, and redo', async () => {
    const repo = await setup(mode, midnight(DEFAULT_DAY))
    const existing = await getOrCreateDailyNote(repo, WS, EXISTING_DAY)
    const existingNote = await repo.load(existing.id)
    await createOwners(repo, {
      first: midnight(EXISTING_DAY),
      same: midnight(EXISTING_DAY),
      distinct: midnight(NEW_DAY),
      missing: undefined,
      unset: null,
    })

    const child = await readValueChild('first')
    const annotated = child?.id ?? 'first'
    const {threadId, commentId} = await createThread(repo, {
      targetId: annotated, anchor: null, comment: 'Keep this annotation',
    })
    await repo.awaitProcessors()
    const original = await liveGraph()
    const originalThread = await repo.load(threadId)
    const originalComment = await repo.load(commentId!)
    const originalUnset = await storedProperties('unset')
    expect(originalThread).not.toBeNull()
    expect(originalComment?.content).toBe('Keep this annotation')
    expect((await storedProperties('first'))[NAME]).toBe(midnight(EXISTING_DAY))
    expect((await storedProperties('missing'))).not.toHaveProperty(NAME)
    if (mode === 'children') {
      expect(child?.content).toBe(midnight(EXISTING_DAY))
    } else {
      expect(child).toBeNull()
      expect(originalUnset[NAME]).toBeNull()
    }

    await retype(repo)
    await repo.awaitProcessors()

    const firstNote = await expectNote(repo, EXISTING_DAY)
    const newNote = await expectNote(repo, NEW_DAY)
    const defaultNote = await expectNote(repo, DEFAULT_DAY)
    expect(firstNote).toBe(existing.id)
    expect(await repo.load(existing.id)).toEqual(existingNote)
    expect((await storedProperties(DEFINITION))[presetIdProp.name]).toBe('day')
    expect((await storedProperties(DEFINITION))[propertyDefaultProp.name]).toBe(defaultNote)
    await vi.waitFor(() => {
      expect(repo.propertySchemas.get(NAME)).toMatchObject({codec: {type: 'ref'}, defaultValue: defaultNote})
    }, {timeout: 3000})
    expect((await storedProperties('first'))[NAME]).toBe(firstNote)
    expect((await storedProperties('same'))[NAME]).toBe(firstNote)
    expect((await storedProperties('distinct'))[NAME]).toBe(newNote)
    expect(await storedProperties('missing')).not.toHaveProperty(NAME)
    expect(await storedProperties('unset')).toEqual(originalUnset)
    if (child) {
      expect(await readValueChild('first')).toEqual({
        ...child, content: `((${firstNote}))`, reference_target_id: firstNote,
      })
    }
    await expectBacklinksFrom(repo, firstNote, ['first', 'same'])
    await expectBacklinksFrom(repo, newNote, ['distinct'])
    expect(await propertyBacklinks(firstNote)).toEqual(['first', 'same'])
    expect(await propertyBacklinks(newNote)).toEqual(['distinct'])
    if (mode === 'children') {
      const definition = propertyDefinitionBlockId(WS, dailyNoteDateProp.seedKey)
      const priorAnchor = await readValueChild(existing.id, definition)
      expect(priorAnchor).toMatchObject({content: midnight(EXISTING_DAY), reference_target_id: null})
      const anchor = await readValueChild(newNote, definition)
      expect(anchor).toMatchObject({content: midnight(NEW_DAY), reference_target_id: null})
    }
    expect(await repo.load(threadId)).toEqual(originalThread)
    expect(await repo.load(commentId!)).toEqual(originalComment)

    const converted = await liveGraph()
    expect(await repo.undo(ChangeScope.BlockDefault)).toBe(true)
    await repo.awaitProcessors()
    await vi.waitFor(() => expect(repo.propertySchemas.get(NAME)?.codec.type).toBe('date'), {timeout: 3000})

    expect(await liveGraph()).toEqual(original)
    expect(await repo.load(newNote)).toBeNull()
    expect(await repo.load(defaultNote)).toBeNull()
    expect(await expectNote(repo, EXISTING_DAY)).toBe(existing.id)

    expect(await repo.redo(ChangeScope.BlockDefault)).toBe(true)
    await repo.awaitProcessors()
    await vi.waitFor(async () => expect(await propertyBacklinks(newNote)).toEqual(['distinct']), {timeout: 3000})
    expect(await liveGraph()).toEqual(converted)
  })

  it('matches a normal typed day write and supports editing the converted value', async () => {
    const repo = await setup(mode)
    await createOwners(repo, {converted: midnight(EXISTING_DAY), normal: undefined})
    await retype(repo)
    await vi.waitFor(() => expect(repo.propertySchemas.get(NAME)?.codec.type).toBe('ref'), {timeout: 3000})
    const convertedNote = dailyNoteBlockId(WS, EXISTING_DAY)
    expect((await storedProperties('converted'))[NAME]).toBe(convertedNote)
    const schema = repo.propertySchemas.get(NAME)!
    const snapshot = repo.snapshotTypeRegistries()
    await repo.tx(tx => setDayProperty(tx, snapshot, 'normal', schema, NEW_DAY), SCOPE)
    await repo.awaitProcessors()

    const normalNote = dailyNoteBlockId(WS, NEW_DAY)
    await expectBacklinksFrom(repo, normalNote, ['normal'])
    await expectBacklinksFrom(repo, convertedNote, ['converted'])
    expect(await propertyBacklinks(convertedNote)).toEqual(['converted'])
    expect(await propertyBacklinks(normalNote)).toEqual(['normal'])

    await repo.tx(tx => setDayProperty(tx, snapshot, 'converted', schema, NEW_DAY), SCOPE)
    await repo.awaitProcessors()
    expect((await storedProperties('converted'))[NAME]).toBe(normalNote)
    expect(await propertyBacklinks(convertedNote)).toEqual([])
    expect(await propertyBacklinks(normalNote)).toEqual(['converted', 'normal'])
  })

  it('counts every non-midnight instant and rolls back all rows', async () => {
    const repo = await setup(mode)
    await createOwners(repo, {
      'a-valid': midnight(NEW_DAY),
      'b-hour': '2026-02-02T08:00:00.000Z',
      'c-fraction': '2026-02-03T00:00:00.001Z',
      'd-unset': null,
    })
    await repo.awaitProcessors()
    const before = await workspaceRows()

    await expect(retype(repo)).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      message: expect.stringContaining('time of day'),
      meta: {fieldId: DEFINITION, name: NAME, count: 2, blockIds: expect.arrayContaining(['b-hour', 'c-fraction'])},
    })
    await repo.awaitProcessors()

    expect(await workspaceRows()).toEqual(before)
  })

  it('keeps sub-millisecond times and validates the UTC day of offset instants', async () => {
    const repo = await setup(mode)
    await createOwners(repo, {example: midnight(NEW_DAY)})
    const putRaw = async (text: string) => {
      const child = mode === 'children' && await readValueChild('example')
      await testDb.db.writeTransaction(async tx => {
        if (child) await tx.execute('UPDATE blocks SET content = ? WHERE id = ?', [text, child.id])
        await tx.execute('UPDATE blocks SET properties_json = json_set(properties_json, ?, ?) WHERE id = ?',
          [`$."${NAME}"`, text, 'example'])
      })
    }
    await putRaw('2026-02-03T00:00:00.000001Z')
    await expect(retype(repo)).rejects.toMatchObject({message: expect.stringContaining('time of day')})
    await putRaw('2026-02-02T16:00:00-08:00')
    await retype(repo)
    expect((await storedProperties('example'))[NAME]).toBe(dailyNoteBlockId(WS, NEW_DAY))
  })

  it('refuses a non-midnight explicit default before it can change the graph', async () => {
    const repo = await setup(mode, '2026-02-04T12:00:00.000Z')
    await createOwners(repo, {owner: midnight(NEW_DAY)})
    await repo.awaitProcessors()
    const before = await workspaceRows()

    await expect(retype(repo)).rejects.toMatchObject({
      code: 'property.definition-change.unconvertible',
      message: expect.stringContaining('time of day'),
      meta: {fieldId: DEFINITION, name: NAME, count: 1},
    })
    await repo.awaitProcessors()

    expect(await workspaceRows()).toEqual(before)
  })
})

const expectRefusalPreservingRows = async (repo: Repo, edit: () => Promise<void>, reason: RegExp) => {
  await repo.awaitProcessors()
  const original = await workspaceRows()
  await expect(edit()).rejects.toThrow(reason)
  await repo.awaitProcessors()
  expect(await workspaceRows()).toEqual(original)
}

it.each(['free', 'orphan', 'swapped'] as const)(
  'refuses a simultaneous date conversion and rename when the destination is %s', async destination => {
    const repo = await setup('cell')
    const otherName = 'test:label'
    const otherDefinition = 'label-definition'
    await createOwners(repo, {owner: midnight(NEW_DAY)})
    if (destination === 'swapped') {
      await repo.tx(tx => tx.create({
        id: otherDefinition, workspaceId: WS, parentId: null, orderKey: 'label', content: otherName,
        properties: {[typesProp.name]: [PROPERTY_SCHEMA_TYPE], [propertyNameProp.name]: otherName, [presetIdProp.name]: 'string'},
      }), SCOPE)
      await vi.waitFor(() => expect(repo.propertySchemas.get(otherName)?.codec.type).toBe('string'))
      await repo.tx(tx => tx.setProperty('owner', repo.propertySchemas.get(otherName)!, 'label value'), SCOPE)
    } else if (destination === 'orphan') {
      await testDb.db.writeTransaction(tx => tx.execute(
        'UPDATE blocks SET properties_json = json_set(properties_json, ?, ?) WHERE id = ?',
        [`$."${otherName}"`, 'label value', 'owner'],
      ))
    }
    expect((await storedProperties('owner'))[otherName]).toBe(destination === 'free' ? undefined : 'label value')
    await expectRefusalPreservingRows(repo, () => repo.tx(async tx => {
      await tx.setProperty(DEFINITION, propertyNameProp, otherName)
      await tx.setProperty(DEFINITION, presetIdProp, 'day')
      if (destination === 'swapped') await tx.setProperty(otherDefinition, propertyNameProp, NAME)
    }, SCOPE), /renam/i)
  },
)

it.each(['cell owner', 'child-backed owner', 'owner missing its projected cell', 'field', 'value'] as const)(
  'preserves restorable date values on a deleted %s', async deleted => {
    const repo = await setup(deleted === 'cell owner' ? 'cell' : 'children')
    await createOwners(repo, {owner: '2026-02-03T12:00:00.000Z', active: midnight(EXISTING_DAY)})
    await repo.awaitProcessors()
    const child = await readValueChild('owner')
    const deletedId = deleted === 'field' ? child!.parent_id : deleted === 'value' ? child!.id : 'owner'
    await repo.tx(tx => tx.delete(deletedId), SCOPE)
    await repo.awaitProcessors()
    if (deleted === 'owner missing its projected cell') {
      await testDb.db.writeTransaction(tx => tx.execute(
        'UPDATE blocks SET properties_json = json_remove(properties_json, ?) WHERE id = ?',
        [`$."${NAME}"`, 'owner'],
      ))
      expect(await readValueChild('owner')).toMatchObject({content: '2026-02-03T12:00:00.000Z'})
      expect((await storedProperties('owner'))[NAME]).toBeUndefined()
    }
    expect(await testDb.db.get('SELECT deleted FROM blocks WHERE id = ?', [deletedId])).toEqual({deleted: 1})
    await expectRefusalPreservingRows(repo, () => retype(repo), /delet|restor|trash/i)
  },
)

it.each(['absent', 'different'] as const)(
  'preserves the cell when its pre-flip child value is %s', async childState => {
    const repo = await setup('children')
    await createOwners(repo, {owner: midnight(NEW_DAY)})
    await repo.awaitProcessors()
    const child = (await readValueChild('owner'))!
    // Before the flip, partial field rows can coexist with an authoritative owner cell.
    await testDb.db.writeTransaction(async tx => {
      await tx.execute("UPDATE workspaces SET properties_migration = 'cell' WHERE id = ?", [WS])
      if (childState === 'absent') await tx.execute('DELETE FROM blocks WHERE id = ?', [child.id])
      else await tx.execute('UPDATE blocks SET content = ? WHERE id = ?', [midnight(EXISTING_DAY), child.id])
    })
    expect((await storedProperties('owner'))[NAME]).toBe(midnight(NEW_DAY))
    expect((await readValueChild('owner'))?.content).toBe(childState === 'absent' ? undefined : midnight(EXISTING_DAY))
    await expectRefusalPreservingRows(repo, () => retype(repo), /disagree|differ|conflict|match|inconsisten/i)
  },
)

it('reports completion for a conversion with only bag consumers', async () => {
  const repo = await setup('cell')
  await createOwners(repo, {one: midnight(NEW_DAY), two: midnight(NEW_DAY)})
  const run = beginPropertyDefinitionFanout(DEFINITION, NAME, 2)
  try {
    markPropertyDefinitionFanoutRunning(DEFINITION)
    await retype(repo)
    expect(propertyDefinitionFanout()).toMatchObject({done: 2, total: 2})
  } finally {
    run.end()
  }
})
