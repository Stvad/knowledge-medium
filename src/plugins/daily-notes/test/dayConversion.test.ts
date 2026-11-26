// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, propertyValue } from '@/data/api'
import { PAGE_TYPE, PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { PROPERTY_VALUES_RESOLVED_EVENT } from '@/data/internals/propertyChildrenProcessor'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import {
  beginPropertyDefinitionFanout,
  markPropertyDefinitionFanoutRunning,
  propertyDefinitionFanout,
} from '@/data/propertyDefinitionFanout'
import {
  aliasesProp,
  presetConfigProp,
  presetIdProp,
  propertyChangeScopeProp,
  propertyDefaultProp,
  propertyNameProp,
  typesProp,
} from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { AppExtension } from '@/facets/facet'
import { annotationsDataExtension } from '@/plugins/annotations/dataExtension'
import { createThread } from '@/plugins/annotations/threads'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension'
import { referencesDataExtension } from '@/plugins/references/dataExtension'
import { srsReschedulingDataExtension } from '@/plugins/srs-rescheduling/dataExtension'
import { SRS_SM25_TYPE, srsNextReviewDateProp } from '@/plugins/srs-rescheduling/schema'
import { buildDueCardsQuery } from '@/plugins/srs-review/dueQuery'
import { dailyNoteBlockId, getOrCreateDailyNote, getOrCreateDailyNoteInTx } from '../dailyNotes'
import { dailyNotesDataExtension } from '../dataExtension'
import { dayValueReferenceAdapter } from '../dayValueReferenceAdapter'
import { referenceDateAdapter } from '../referenceDateAdapter'
import { DAILY_NOTE_TYPE, dailyNoteDateProp } from '../schema'

const WS = 'date-conversion-workspace'
const USER = {id: 'test-user'}
const DEFINITION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const NAME = 'test:appointment-date'
const SCOPE = {scope: ChangeScope.BlockDefault}
const EXISTING_DAY = '2026-02-02'
const NEW_DAY = '2026-02-03'
const NEW_DAY_TITLE = 'February 3rd, 2026'
const DEFAULT_DAY = '2026-02-04'
const midnight = (day: string) => `${day}T00:00:00.000Z`

let testDb: TestDb
beforeAll(async () => { testDb = await createTestDb() })
afterAll(async () => { await testDb.cleanup() })
beforeEach(async () => { await resetTestDb(testDb.db) })

const setup = async (mode: 'cell' | 'children', defaultValue?: string, extensions: readonly AppExtension[] = []) => {
  await testDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test workspace', ?, 1, 1, 'none', NULL, ?)`,
    [WS, USER.id, mode],
  )
  const {repo} = createTestRepo({
    db: testDb.db,
    user: USER,
    extensions: [dailyNotesDataExtension, referencesDataExtension, backlinksDataExtension, annotationsDataExtension, ...extensions],
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

const childBackedDay = async (owners: string[]) => {
  const repo = await setup('children')
  await createOwners(repo, Object.fromEntries(owners.map(owner => [owner, undefined])))
  await retype(repo)
  await vi.waitFor(() => expect(repo.propertySchemas.get(NAME)?.codec.type).toBe('ref'))
  return {repo, schema: repo.propertySchemas.get(NAME)!}
}

const createAliasOwner = async (repo: Repo, title = NEW_DAY_TITLE) => {
  const id = 'ordinary-page'
  await repo.tx(tx => tx.create({
    id, workspaceId: WS, parentId: null, orderKey: 'claimant', content: title,
    properties: {[aliasesProp.name]: [title], [typesProp.name]: [PAGE_TYPE]},
  }), SCOPE)
  return id
}

describe('child-backed daily-note references', () => {
  it.each(['ID', 'named'] as const)('preserves the divergent ID peer before the leading %s day’s alias arrives', async form => {
    const {repo, schema} = await childBackedDay(['owner'])
    const primary = await getOrCreateDailyNote(repo, WS, EXISTING_DAY)
    const other = await getOrCreateDailyNote(repo, WS, DEFAULT_DAY)
    const replacement = await getOrCreateDailyNote(repo, WS, NEW_DAY)
    await repo.tx(tx => tx.setProperty('owner', schema, primary.id), SCOPE)
    await repo.awaitProcessors()
    const value = (await readValueChild('owner'))!
    const peerContent = `((${other.id}))`
    await repo.tx(tx => tx.create({id: 'offline-peer', workspaceId: WS, parentId: value.parent_id,
      content: peerContent, orderKey: 'zz'}), SCOPE)
    await repo.awaitProcessors()
    const first = form === 'ID' ? {content: `((${primary.id}))`, reference_target_id: primary.id}
      : {content: '[[February 2nd, 2026]]', reference_target_id: null}
    // A synced owner and its value rows can arrive before the target’s aliases.
    await testDb.db.writeTransaction(async db => {
      await db.execute("UPDATE blocks SET properties_json = json_remove(properties_json, ?) WHERE id = ?", [`$."${aliasesProp.name}"`, primary.id])
      await db.execute('UPDATE blocks SET content = ?, reference_target_id = ? WHERE id = ?', [first.content, first.reference_target_id, value.id])
    })
    expect(await repo.query.aliasLookup({workspaceId: WS, alias: 'February 2nd, 2026'}).load()).toBeNull()
    expect((await storedProperties('owner'))[NAME]).toBe(primary.id)
    expect(await testDb.db.get('SELECT content, reference_target_id FROM blocks WHERE id=?', [value.id]))
      .toEqual(first)
    expect(await testDb.db.get('SELECT content FROM blocks WHERE id=?', ['offline-peer'])).toEqual({content: peerContent})

    const refreshPeer = () => repo.tx(async tx => {
      tx.emitEvent(PROPERTY_VALUES_RESOLVED_EVENT, {workspaceId: WS, valueIds: ['offline-peer']}, WS)
    }, SCOPE)
    await refreshPeer()
    expect((await storedProperties('owner'))[NAME]).toBe(primary.id)

    await repo.tx(tx => tx.setProperty('owner', schema, replacement.id), SCOPE)
    expect(await testDb.db.get('SELECT content, reference_target_id FROM blocks WHERE id=?', [value.id]))
      .toEqual({content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: replacement.id})
    expect(await testDb.db.get('SELECT content FROM blocks WHERE id=?', ['offline-peer'])).toEqual({content: peerContent})

    await primary.set(aliasesProp, [EXISTING_DAY, 'February 2nd, 2026'])
    await repo.awaitProcessors()
    await repo.awaitReferenceTargetDerive()
    expect(await repo.query.aliasLookup({workspaceId: WS, alias: 'February 2nd, 2026'}).load()).toMatchObject({id: primary.id})
    await refreshPeer()
    expect((await storedProperties('owner'))[NAME]).toBe(replacement.id)
  })

  it('materializes the same named reference from scalar, batch, and raw bag writes', async () => {
    const {repo, schema} = await childBackedDay(['single', 'batch', 'bag'])
    const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
    await repo.tx(async tx => {
      await tx.setProperty('single', schema, note.id)
      await tx.setProperties('batch', {set: [propertyValue(schema, note.id)]})
      await tx.update('bag', {properties: {[NAME]: note.id}})
    }, SCOPE)
    await repo.awaitProcessors()

    for (const owner of ['single', 'batch', 'bag']) {
      expect(await readValueChild(owner)).toMatchObject({
        content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: note.id,
      })
      expect((await storedProperties(owner))[NAME]).toBe(note.id)
    }
    await expectBacklinksFrom(repo, note.id, ['single', 'batch', 'bag'])
  })

  it('backfills a historical bag as a named reference', async () => {
    const {repo} = await childBackedDay(['owner'])
    const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
    await repo.awaitProcessors()
    await testDb.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify({[NAME]: note.id}), 'owner'],
    ))
    expect((await storedProperties('owner'))[NAME]).toBe(note.id)
    expect(await readValueChild('owner')).toBeNull()

    expect(await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)).toMatchObject({outcome: 'ran'})
    await repo.awaitProcessors()

    expect(await readValueChild('owner')).toMatchObject({
      content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: note.id,
    })
    expect((await storedProperties('owner'))[NAME]).toBe(note.id)
    await expectBacklinksFrom(repo, note.id, ['owner'])
  })

  it('retargets a named value on alias rename and continues to read the existing ID form', async () => {
    const {repo, schema} = await childBackedDay(['named', 'legacy'])
    const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
    await repo.tx(async tx => {
      await tx.setProperty('named', schema, note.id)
      await tx.setProperty('legacy', schema, note.id)
    }, SCOPE)
    await repo.awaitProcessors()
    const named = await readValueChild('named')
    const legacy = await readValueChild('legacy')
    expect(named?.content).toBe(`[[${NEW_DAY_TITLE}]]`)
    expect(legacy?.content).toBe(`[[${NEW_DAY_TITLE}]]`)
    await repo.tx(tx => tx.update(legacy!.id, {content: `((${note.id}))`}), SCOPE)
    await repo.awaitProcessors()
    const originalIdLink = await readValueChild('legacy')
    expect(originalIdLink).toEqual({...legacy, content: `((${note.id}))`})

    await note.set(aliasesProp, ['Renamed appointment', NEW_DAY])
    await repo.awaitProcessors()
    expect(await repo.query.aliasLookup({workspaceId: WS, alias: 'Renamed appointment'}).load()).toMatchObject({id: note.id})
    expect(await readValueChild('named')).toEqual({...named, content: '[[Renamed appointment]]'})
    expect(await readValueChild('legacy')).toEqual(originalIdLink)
    expect((await storedProperties('named'))[NAME]).toBe(note.id)
    expect((await storedProperties('legacy'))[NAME]).toBe(note.id)
    await expectBacklinksFrom(repo, note.id, ['named', 'legacy'])

    const row = repo.block(named!.id)
    await row.load()
    expect(dayValueReferenceAdapter.canHandle(row)).toBe(true)
    expect(await dayValueReferenceAdapter.getCurrentIso(row)).toBe(NEW_DAY)
    expect(await dayValueReferenceAdapter.setIso(row, EXISTING_DAY)).toBe(true)
    const replacement = dailyNoteBlockId(WS, EXISTING_DAY)
    expect(await readValueChild('named')).toEqual({...named, content: '[[February 2nd, 2026]]', reference_target_id: replacement})
    expect((await storedProperties('named'))[NAME]).toBe(replacement)
    expect(await readValueChild('legacy')).toEqual(originalIdLink)
    await repo.awaitProcessors()
    await expectBacklinksFrom(repo, note.id, ['legacy'])
    await expectBacklinksFrom(repo, replacement, ['named'])
  })

  it.each(['setProperty', 'setProperties'] as const)('keeps the daily note on repeated %s writes when another page owns its title', async writer => {
    const {repo, schema} = await childBackedDay(['owner'])
    const claimant = await createAliasOwner(repo)
    const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
    expect(note.id).not.toBe(claimant)
    expect(await expectNote(repo, NEW_DAY)).toBe(note.id)
    expect(await repo.query.aliasLookup({workspaceId: WS, alias: NEW_DAY_TITLE}).load()).toMatchObject({id: claimant})

    const write = () => repo.tx(tx => writer === 'setProperty'
      ? tx.setProperty('owner', schema, note.id)
      : tx.setProperties('owner', {set: [propertyValue(schema, note.id)]}), SCOPE)
    await write()
    await repo.awaitProcessors()
    const child = await readValueChild('owner')
    expect(child).toMatchObject({content: `((${note.id}))`, reference_target_id: note.id})
    expect((await storedProperties('owner'))[NAME]).toBe(note.id)

    const before = await liveGraph()
    await write()
    await repo.awaitProcessors()

    expect(await readValueChild('owner')).toEqual(child)
    expect((await storedProperties('owner'))[NAME]).toBe(note.id)
    expect(await propertyBacklinks(claimant)).toEqual([])
    expect(await propertyBacklinks(note.id)).toEqual(['owner'])
    expect(await liveGraph()).toEqual(before)
  })

  it.each([[NEW_DAY, NEW_DAY_TITLE], ['0900-03-01', 'March 1st, 900']])('keeps the note when converting %s and another page owns its title', async (day, title) => {
    const repo = await setup('children')
    const claimant = await createAliasOwner(repo, title)
    await createOwners(repo, {owner: midnight(day)})
    const original = await readValueChild('owner')
    expect(original).toMatchObject({content: midnight(day), reference_target_id: null})

    await retype(repo)
    await repo.awaitProcessors()

    const note = await expectNote(repo, day)
    expect(await readValueChild('owner')).toEqual({
      ...original, content: `((${note}))`, reference_target_id: note,
    })
    expect((await storedProperties('owner'))[NAME]).toBe(note)
    expect(await propertyBacklinks(claimant)).toEqual([])
    expect(await propertyBacklinks(note)).toEqual(['owner'])
  })

  it.each([
    ['ISO', EXISTING_DAY, false],
    ['ISO', EXISTING_DAY, true],
    ['long-form', 'February 2nd, 2026', true],
  ] as const)('scrubs a %s wikilink (%s) to the new note with a title conflict of %s', async (_form, alias, conflict) => {
    const {repo, schema} = await childBackedDay(['owner'])
    const initial = await getOrCreateDailyNote(repo, WS, EXISTING_DAY)
    const claimant = conflict ? await createAliasOwner(repo) : null
    await repo.tx(tx => tx.setProperty('owner', schema, initial.id), SCOPE)
    const row = repo.block((await readValueChild('owner'))!.id)
    await row.setContent(`[[${alias}]]`)
    await repo.awaitProcessors()
    expect(await referenceDateAdapter.getCurrentIso(row)).toBe(EXISTING_DAY)
    expect((await storedProperties('owner'))[NAME]).toBe(initial.id)
    const next = dailyNoteBlockId(WS, NEW_DAY)
    expect(await repo.load(next)).toBeNull()

    expect(await referenceDateAdapter.setIso(row, NEW_DAY)).toBe(true)

    expect(await expectNote(repo, NEW_DAY)).toBe(next)
    expect(await readValueChild('owner')).toMatchObject({
      id: row.id, content: conflict ? `((${next}))` : `[[${NEW_DAY_TITLE}]]`, reference_target_id: next,
    })
    expect((await storedProperties('owner'))[NAME]).toBe(next)
    expect(await repo.query.aliasLookup({workspaceId: WS, alias: NEW_DAY_TITLE}).load()).toMatchObject({id: claimant ?? next})
  })

  it.each(['plain', 'labeled'] as const)('reschedules a legacy %s ID reference and title-conflict ID value in place', async form => {
    const {repo, schema} = await childBackedDay(['owner'])
    const initial = await getOrCreateDailyNote(repo, WS, EXISTING_DAY)
    const claimant = await createAliasOwner(repo)
    await repo.tx(tx => tx.setProperty('owner', schema, initial.id), SCOPE)
    const value = (await readValueChild('owner'))!
    const block = repo.block(value.id)
    const original = form === 'plain' ? `((${initial.id}))` : `[Daily log](((${initial.id})))`
    await block.setContent(original)
    await repo.block(value.parent_id).load()
    await repo.tx(tx => tx.create({id: 'plain-ref', parentId: 'owner', workspaceId: WS,
      orderKey: 'zz', content: original}), SCOPE)
    const plain = repo.block('plain-ref')
    await plain.load()
    expect(dayValueReferenceAdapter.canHandle(plain)).toBe(false)
    expect(await dayValueReferenceAdapter.getCurrentIso(plain)).toBeNull()
    expect(await dayValueReferenceAdapter.setIso(plain, NEW_DAY)).toBe(false)
    const nextId = dailyNoteBlockId(WS, NEW_DAY)
    expect(await repo.load(nextId)).toBeNull()

    expect(dayValueReferenceAdapter.canHandle(block)).toBe(true)
    expect(await dayValueReferenceAdapter.getCurrentIso(block)).toBe(EXISTING_DAY)
    expect(await dayValueReferenceAdapter.setIso(block, EXISTING_DAY)).toBe(false)
    expect(await readValueChild('owner')).toEqual({...value, content: original})
    expect(await dayValueReferenceAdapter.setIso(block, NEW_DAY)).toBe(true)
    expect(await readValueChild('owner')).toEqual({...value, content: `((${nextId}))`, reference_target_id: nextId})
    expect((await storedProperties('owner'))[NAME]).toBe(nextId)
    expect(await propertyBacklinks(claimant)).toEqual([])

    expect(dayValueReferenceAdapter.canHandle(block)).toBe(true)
    expect(await dayValueReferenceAdapter.getCurrentIso(block)).toBe(NEW_DAY)
    expect(await dayValueReferenceAdapter.setIso(block, DEFAULT_DAY)).toBe(true)
    const finalId = dailyNoteBlockId(WS, DEFAULT_DAY)
    expect(await readValueChild('owner')).toEqual({...value, content: '[[February 4th, 2026]]', reference_target_id: finalId})
    expect((await storedProperties('owner'))[NAME]).toBe(finalId)
  })

  it.each(['moved value', 'deleted field', 'deleted owner', 'deleted target'] as const)(
    'refuses a retained ID day gesture after a %s', async stale => {
      const {repo, schema} = await childBackedDay(['owner'])
      const note = await getOrCreateDailyNote(repo, WS, EXISTING_DAY)
      await repo.tx(tx => tx.setProperty('owner', schema, note.id), SCOPE)
      const value = (await readValueChild('owner'))!
      const block = repo.block(value.id)
      const content = `((${note.id}))`
      await block.setContent(content)
      await repo.block(value.parent_id).load()
      expect(dayValueReferenceAdapter.canHandle(block)).toBe(true)
      expect(await dayValueReferenceAdapter.getCurrentIso(block)).toBe(EXISTING_DAY)

      // Simulate a sync arrival while the gesture has retained its old view.
      await testDb.db.writeTransaction(async db => {
        if (stale === 'moved value') {
          await db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', ['owner', value.id])
        } else {
          const id = stale === 'deleted field' ? value.parent_id : stale === 'deleted owner' ? 'owner' : note.id
          await db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [id])
        }
      })
      expect(await dayValueReferenceAdapter.setIso(block, NEW_DAY)).toBe(false)
      expect(await testDb.db.get('SELECT content FROM blocks WHERE id = ?', [value.id])).toEqual({content})
      expect((await storedProperties('owner'))[NAME]).toBe(note.id)
      expect(await repo.load(dailyNoteBlockId(WS, NEW_DAY))).toBeNull()
    },
  )

  it.each(['typed write', 'value block edit'] as const)('clears a day to a blank on the same value row through a %s', async edit => {
    const {repo, schema} = await childBackedDay(['owner'])
    const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
    await repo.tx(tx => tx.setProperty('owner', schema, note.id), SCOPE)
    await repo.awaitProcessors()
    const linked = await readValueChild('owner')
    expect(linked).toMatchObject({content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: note.id})

    await repo.tx(tx => edit === 'typed write'
      ? tx.setProperty('owner', schema, undefined)
      : tx.update(linked!.id, {content: ''}), SCOPE)
    await repo.awaitProcessors()

    expect(await readValueChild('owner')).toEqual({...linked, content: '', reference_target_id: null})
    expect((await storedProperties('owner'))[NAME]).toBeNull()
    expect(await propertyBacklinks(note.id)).toEqual([])
  })
})

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
        ...child, content: '[[February 2nd, 2026]]', reference_target_id: firstNote,
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
    await repo.tx(async tx => tx.setProperty('normal', schema, await getOrCreateDailyNoteInTx(tx, snapshot, WS, NEW_DAY)), SCOPE)
    await repo.awaitProcessors()

    const normalNote = dailyNoteBlockId(WS, NEW_DAY)
    await expectBacklinksFrom(repo, normalNote, ['normal'])
    await expectBacklinksFrom(repo, convertedNote, ['converted'])
    expect(await propertyBacklinks(convertedNote)).toEqual(['converted'])
    expect(await propertyBacklinks(normalNote)).toEqual(['normal'])

    await repo.tx(async tx => tx.setProperty('converted', schema, await getOrCreateDailyNoteInTx(tx, snapshot, WS, NEW_DAY)), SCOPE)
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

describe.each(['cell', 'children'] as const)('historical values in %s storage', mode => {
  it('converts the live dates after clearing an ordinary value', async () => {
    const repo = await setup(mode)
    await createOwners(repo, {cleared: '2026-02-03T12:00:00.000Z', active: midnight(EXISTING_DAY)})
    const schema = repo.propertySchemas.get(NAME)!
    const originalChild = await readValueChild('cleared')
    await repo.tx(tx => tx.unsetProperty('cleared', schema), SCOPE)
    await repo.awaitProcessors()
    expect(await storedProperties('cleared')).not.toHaveProperty(NAME)
    expect(await readValueChild('cleared')).toBeNull()
    const tombstone = originalChild && await testDb.db.get('SELECT * FROM blocks WHERE id = ?', [originalChild.id])
    if (tombstone) expect(tombstone).toMatchObject({deleted: 1, content: '2026-02-03T12:00:00.000Z'})

    await retype(repo)

    expect(await storedProperties('cleared')).not.toHaveProperty(NAME)
    expect(await readValueChild('cleared')).toBeNull()
    if (originalChild) expect(await testDb.db.get('SELECT * FROM blocks WHERE id = ?', [originalChild.id])).toEqual(tombstone)
    expect((await storedProperties('active'))[NAME]).toBe(await expectNote(repo, EXISTING_DAY))
  })

  it('restores the historical bytes of an owner deleted before conversion', async () => {
    const repo = await setup(mode)
    const historical = '2026-02-03T12:00:00.000Z'
    await createOwners(repo, {owner: historical, active: midnight(EXISTING_DAY)})
    const bag = await storedProperties('owner')
    const child = await readValueChild('owner')
    await repo.tx(tx => tx.delete('owner'), SCOPE)
    await repo.awaitProcessors()
    const tombstone = await testDb.db.get('SELECT * FROM blocks WHERE id = ?', ['owner'])
    expect(tombstone).toMatchObject({deleted: 1})
    expect(bag[NAME]).toBe(historical)

    await retype(repo)

    expect(await testDb.db.get('SELECT * FROM blocks WHERE id = ?', ['owner'])).toEqual(tombstone)
    expect(await readValueChild('owner')).toEqual(child)
    expect((await storedProperties('active'))[NAME]).toBe(await expectNote(repo, EXISTING_DAY))
    await repo.tx(tx => tx.restore('owner'), SCOPE)
    await repo.awaitProcessors()
    expect(await repo.load('owner')).toMatchObject({id: 'owner', deleted: false})
    if (mode === 'cell') expect(await storedProperties('owner')).toEqual(bag)
    else expect(await readValueChild('owner')).toEqual(child)
  })

  it('preserves an explicit null when the destination requires a reference', async () => {
    const repo = await setup(mode)
    await createOwners(repo, {unset: null})
    expect((await storedProperties('unset'))[NAME]).toBeNull()
    await expectRefusalPreservingRows(repo, () => repo.tx(async tx => {
      await tx.setProperty(DEFINITION, presetIdProp, 'ref')
      await tx.setProperty(DEFINITION, presetConfigProp, {targetTypes: [DAILY_NOTE_TYPE]})
    }, SCOPE), /destination type/)
  })

  it.each(['ref', 'optional-ref'] as const)('converts date to a plain %s configured for daily notes', async preset => {
    const repo = await setup(mode, midnight(DEFAULT_DAY))
    await createOwners(repo, {owner: midnight(NEW_DAY)})
    const child = await readValueChild('owner')

    await repo.tx(async tx => {
      await tx.setProperty(DEFINITION, presetIdProp, preset)
      await tx.setProperty(DEFINITION, presetConfigProp, {targetTypes: [DAILY_NOTE_TYPE]})
    }, SCOPE)

    const note = await expectNote(repo, NEW_DAY)
    const defaultNote = await expectNote(repo, DEFAULT_DAY)
    expect((await storedProperties('owner'))[NAME]).toBe(note)
    expect((await storedProperties(DEFINITION))[propertyDefaultProp.name]).toBe(defaultNote)
    if (child) expect(await readValueChild('owner')).toEqual({
      ...child, content: '[[February 3rd, 2026]]', reference_target_id: note,
    })
    await expectBacklinksFrom(repo, note, ['owner'])
  })
})

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

it('repairs a mismatched target column when the daily note owns the equal wikilink', async () => {
  const {repo, schema} = await childBackedDay(['owner'])
  const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
  const other = await getOrCreateDailyNote(repo, WS, EXISTING_DAY)
  await repo.tx(tx => tx.setProperty('owner', schema, note.id), SCOPE)
  await repo.awaitProcessors()
  const child = (await readValueChild('owner'))!
  expect(child).toMatchObject({content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: note.id})
  await testDb.db.execute('UPDATE blocks SET reference_target_id = ? WHERE id = ?', [other.id, child.id])
  expect(await readValueChild('owner')).toEqual({...child, reference_target_id: other.id})
  await repo.tx(tx => tx.setProperty('owner', schema, note.id), SCOPE)
  await repo.awaitProcessors()
  expect(await readValueChild('owner')).toEqual(child)
  expect((await storedProperties('owner'))[NAME]).toBe(note.id)
})

it.each([false, true])('materializes the converted bag and its resolved target with an alias conflict of %s', async conflict => {
  const repo = await setup('children')
  if (conflict) await createAliasOwner(repo)
  const expected = dailyNoteBlockId(WS, NEW_DAY)
  await createOwners(repo, {owner: undefined})
  await repo.awaitProcessors()
  await testDb.db.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify({[NAME]: midnight(NEW_DAY)}), 'owner'])
  expect(await readValueChild('owner')).toBeNull()

  await retype(repo)
  await repo.awaitProcessors()
  expect(await readValueChild('owner')).toMatchObject({
    content: conflict ? `((${expected}))` : `[[${NEW_DAY_TITLE}]]`, reference_target_id: expected,
  })
  expect((await storedProperties('owner'))[NAME]).toBe(expected)
})

it('uses named links for SRS review dates and keeps cards due when another page owns the title', async () => {
  const repo = await setup('children', undefined, [srsReschedulingDataExtension])
  const claimant = await createAliasOwner(repo)
  const initial = await getOrCreateDailyNote(repo, WS, EXISTING_DAY)
  const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
  const field = propertyDefinitionBlockId(WS, srsNextReviewDateProp.seedKey)
  await repo.tx(async tx => {
    await tx.create({id: 'card', workspaceId: WS, parentId: null, orderKey: 'card', content: 'card'})
    await tx.setProperty('card', typesProp, [SRS_SM25_TYPE])
    await tx.setProperty('card', srsNextReviewDateProp, initial.id)
  }, SCOPE)
  expect(await readValueChild('card', field)).toMatchObject({
    content: '[[February 2nd, 2026]]', reference_target_id: initial.id,
  })
  const value = repo.block((await readValueChild('card', field))!.id)
  await value.setContent(`((${initial.id}))`)
  expect((await readValueChild('card', field))?.content).toBe(`((${initial.id}))`)
  await repo.tx(tx => tx.setProperty('card', srsNextReviewDateProp, initial.id), SCOPE)
  expect(await readValueChild('card', field)).toMatchObject({
    id: value.id, content: '[[February 2nd, 2026]]', reference_target_id: initial.id,
  })

  await repo.tx(tx => tx.setProperty('card', srsNextReviewDateProp, note.id), SCOPE)
  expect(await readValueChild('card', field)).toMatchObject({content: `((${note.id}))`, reference_target_id: note.id})
  expect((await storedProperties('card'))[srsNextReviewDateProp.name]).toBe(note.id)
  expect(await propertyBacklinks(claimant, srsNextReviewDateProp.name)).toEqual([])
  const due = await repo.queryBlocks(buildDueCardsQuery({workspaceId: WS, now: new Date(2026, 1, 4)}))
  expect(due.map(card => card.id)).toEqual(['card'])
})

it('first long alias claim on a self-referencing ISO seat survives the outer setter', async () => {
  const {repo, schema} = await childBackedDay([])
  const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
  await note.setContent(NEW_DAY)
  await note.set(aliasesProp, [NEW_DAY])
  await repo.awaitProcessors()
  expect((await repo.load(note.id))?.content).toBe(NEW_DAY)
  expect(await repo.query.aliasLookup({workspaceId: WS, alias: NEW_DAY_TITLE}).load()).toBeNull()
  await repo.tx(tx => tx.setProperty(note.id, schema, note.id), SCOPE)
  await repo.awaitProcessors()
  expect(await repo.query.aliasLookup({workspaceId: WS, alias: NEW_DAY_TITLE}).load()).toMatchObject({id: note.id})
  const child = await readValueChild(note.id)
  expect(child).toMatchObject({content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: note.id})
})

it('claims a free long title on the requested daily note when another page owns its ISO alias', async () => {
  const {repo, schema} = await childBackedDay(['owner'])
  const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
  await note.setContent(NEW_DAY)
  await note.set(aliasesProp, [])
  await repo.awaitProcessors()
  const claimant = await createAliasOwner(repo, NEW_DAY)
  expect(await repo.query.aliasLookup({workspaceId: WS, alias: NEW_DAY_TITLE}).load()).toBeNull()

  await repo.tx(tx => tx.setProperty('owner', schema, note.id), SCOPE)
  await repo.awaitProcessors()

  expect(await readValueChild('owner')).toMatchObject({content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: note.id})
  expect((await storedProperties('owner'))[NAME]).toBe(note.id)
  expect(await repo.query.aliasLookup({workspaceId: WS, alias: NEW_DAY_TITLE}).load()).toMatchObject({id: note.id})
  expect((await storedProperties(claimant))[aliasesProp.name]).toEqual([NEW_DAY])
})

it('retyping authored named text into a day reuses its long wikilink', async () => {
  const repo = await setup('children')
  const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
  await createOwners(repo, {owner: undefined})
  await repo.tx(tx => tx.setProperty(DEFINITION, presetIdProp, 'string'), SCOPE)
  await vi.waitFor(() => expect(repo.propertySchemas.get(NAME)?.codec.type).toBe('string'))
  await repo.tx(tx => tx.setProperty('owner', repo.propertySchemas.get(NAME)!, 'temporary'), SCOPE)
  const child = (await readValueChild('owner'))!
  await repo.tx(tx => tx.update(child.id, {content: `[[${NEW_DAY_TITLE}]]`}), SCOPE)
  await repo.awaitProcessors()
  expect(await readValueChild('owner')).toMatchObject({content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: note.id})
  await retype(repo)
  await repo.awaitProcessors()
  expect(await readValueChild('owner')).toMatchObject({content: `[[${NEW_DAY_TITLE}]]`, reference_target_id: note.id})
  expect((await storedProperties('owner'))[NAME]).toBe(note.id)
})

it('counts a stored day awaiting its alias when checking for lossy retyping', async () => {
  const {repo, schema} = await childBackedDay(['owner'])
  const note = await getOrCreateDailyNote(repo, WS, NEW_DAY)
  await repo.tx(tx => tx.setProperty('owner', schema, note.id), SCOPE)
  await repo.awaitProcessors()
  const child = (await readValueChild('owner'))!
  await testDb.db.writeTransaction(async db => {
    await db.execute('UPDATE blocks SET properties_json = json_remove(properties_json, ?) WHERE id = ?',
      [`$."${aliasesProp.name}"`, note.id])
    await db.execute('UPDATE blocks SET reference_target_id = NULL WHERE id = ?', [child.id])
  })
  expect((await storedProperties('owner'))[NAME]).toBe(note.id)
  expect(await readValueChild('owner')).toEqual({...child, reference_target_id: null})
  await expectRefusalPreservingRows(repo, () => repo.tx(tx => tx.setProperty(DEFINITION, presetIdProp, 'number'), SCOPE), /lose|loss|unconvertible/i)
})
