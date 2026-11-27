// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty } from '@/data/api'
import { materializePropertySeeds, propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { definitionSeedsFacet } from '@/data/facets'
import { aliasesProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { groupedBacklinksDataExtension } from '@/plugins/grouped-backlinks/dataExtension.ts'
import { referencesDataExtension } from '@/plugins/references/dataExtension.ts'
import { backlinksDataExtension } from '../dataExtension.ts'

const WS = 'ws-backlink-properties'
const USER = {id: 'test-user'}
const OWNER = 'owner'
const TARGET = '22222222-2222-4222-8222-222222222222'
const OTHER_TARGET = '33333333-3333-4333-8333-333333333333'
const targetRef = `((${TARGET}))`

const related = seedProperty({
  seedKey: 'test:backlinks/property/related', revision: 1, name: 'backlinks-test:related',
  preset: 'ref', changeScope: ChangeScope.BlockDefault,
})
const members = seedProperty({
  seedKey: 'test:backlinks/property/members', revision: 1, name: 'backlinks-test:members',
  preset: 'refList', changeScope: ChangeScope.BlockDefault,
})
const description = seedProperty({
  seedKey: 'test:backlinks/property/description', revision: 1, name: 'backlinks-test:description',
  preset: 'string', changeScope: ChangeScope.BlockDefault,
})
const day = seedProperty({
  seedKey: 'test:backlinks/property/day', revision: 1, name: 'backlinks-test:day',
  preset: 'optional-ref', config: {targetTypes: ['daily-note']}, changeScope: ChangeScope.BlockDefault,
})
const seeds = [related, members, description, day]

const scope = {scope: ChangeScope.BlockDefault}
const args = {workspaceId: WS, id: TARGET}
let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({
    db: sharedDb.db,
    user: USER,
    extensions: [
      referencesDataExtension, backlinksDataExtension, groupedBacklinksDataExtension,
      seeds.map(seed => definitionSeedsFacet.of(seed, {source: 'test'})),
    ],
  }).repo
  repo.setActiveWorkspaceId(WS)
  await vi.waitFor(() => expect(repo.propertySchemas.has(description.name)).toBe(true))
  await materializePropertySeeds(repo, WS, seeds)
  await repo.tx(tx => tx.createMany([
    {id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Owner'},
    {id: TARGET, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Target'},
    {id: OTHER_TARGET, workspaceId: WS, parentId: null, orderKey: 'a2', content: 'Other target'},
  ]), scope)
})

const fieldFor = async (seedKey: string): Promise<string> => {
  const children = await repo.query.children({id: OWNER, propertyChildren: 'all'}).load()
  const field = children.find(row => row.referenceTargetId === propertyDefinitionBlockId(WS, seedKey))
  expect(field?.isFieldForm).toBe(true)
  return field!.id
}

const childIds = (id: string) => repo.query.childIds({id, propertyChildren: 'all'}).load()
const mentions = (id = TARGET) => repo.query['backlinks.forBlock']({workspaceId: WS, id}).load()
const rawMentions = () => repo.query['backlinks.forBlock']({...args, rawSources: true}).load()
const targetEdges = () => sharedDb.db.getAll<{source_id: string; source_field: string}>(
  `SELECT source_id, source_field FROM block_references
   WHERE workspace_id = ? AND target_id = ? ORDER BY source_id, source_field`,
  [WS, TARGET],
)

describe('property value backlinks', () => {
  it('shows the owner’s scalar reference in flat and grouped backlinks while keeping the raw value edge', async () => {
    await repo.tx(tx => tx.setProperty(OWNER, related, TARGET), scope)
    await repo.awaitProcessors()
    const field = await fieldFor(related.seedKey)
    const [value] = await childIds(field)

    expect(await rawMentions()).toEqual([value, OWNER])
    expect(await targetEdges()).toEqual([
      {source_id: value, source_field: ''},
      {source_id: OWNER, source_field: related.name},
    ])
    expect(await mentions(propertyDefinitionBlockId(WS, related.seedKey))).toEqual([field])

    expect(await mentions()).toEqual([OWNER])
    expect(await repo.query['backlinks.countForBlock'](args).load()).toBe(1)
    expect(await repo.query['backlinks.forBlock']({
      ...args, filter: {include: [{scope: 'ancestor', id: OWNER}]},
    }).load()).toEqual([OWNER])
    const grouped = await repo.query['groupedBacklinks.forBlock'](args).load()
    expect(grouped.total).toBe(1)
    expect(grouped.groups).toMatchObject([{groupId: `field:${related.name}`, sourceIds: [OWNER]}])
  })

  it('keeps prose, named links and notes nested beneath a duplicate value', async () => {
    await repo.tx(async tx => {
      await tx.setProperty(TARGET, aliasesProp, ['Sample target'])
      await tx.setProperty(OWNER, related, TARGET)
      await tx.setProperty(OWNER, description, `See ${targetRef}`)
    }, scope)
    const field = await fieldFor(related.seedKey)
    const [value] = await childIds(field)
    const [textValue] = await childIds(await fieldFor(description.seedKey))
    await repo.tx(tx => tx.createMany([
      {id: 'nested', workspaceId: WS, parentId: value!, orderKey: 'a0', content: targetRef},
      {id: 'prose', workspaceId: WS, parentId: field, orderKey: 'z1', content: `See ${targetRef}`},
      {id: 'alias', workspaceId: WS, parentId: field, orderKey: 'z2', content: '[[Sample target]]'},
    ]), scope)
    await repo.awaitProcessors()

    expect((await repo.load('alias'))?.referenceTargetId).toBe(TARGET)
    const visible = ['alias', textValue!, 'nested', OWNER, 'prose'].sort()
    expect((await rawMentions()).toSorted()).toEqual([...visible, value!].sort())
    expect((await mentions()).toSorted()).toEqual(visible)
    expect(await repo.query['backlinks.countForBlock'](args).load()).toBe(visible.length)
  })

  it('keeps a scalar peer for a target the owner projects from another field', async () => {
    await repo.tx(async tx => {
      await tx.setProperty(OWNER, related, OTHER_TARGET)
      await tx.setProperty(OWNER, members, [TARGET])
      await tx.create({id: 'peer', workspaceId: WS, parentId: null, orderKey: 'a4', content: targetRef})
    }, scope)
    await repo.awaitProcessors()
    const relatedField = await fieldFor(related.seedKey)
    const [member] = await childIds(await fieldFor(members.seedKey))

    // A second scalar value can arrive before the owner is reprojected.
    await sharedDb.db.writeTransaction(async tx => {
      await tx.execute('UPDATE blocks SET parent_id = ?, order_key = ? WHERE id = ?',
        [relatedField, 'zz', 'peer'])
    })

    expect((await rawMentions()).toSorted()).toEqual([member!, OWNER, 'peer'].sort())
    const [current, other] = await Promise.all([mentions(), mentions(OTHER_TARGET)])
    expect(current.toSorted()).toEqual([OWNER, 'peer'])
    expect(other).toEqual([OWNER])
  })

  it('keeps the value row when it has its own property reference to the target', async () => {
    await repo.tx(tx => tx.setProperty(OWNER, related, TARGET), scope)
    const [value] = await childIds(await fieldFor(related.seedKey))
    await repo.tx(tx => tx.setProperty(value!, members, [TARGET]), scope)
    await repo.awaitProcessors()

    expect(await targetEdges()).toEqual(expect.arrayContaining([
      {source_id: value, source_field: ''},
      {source_id: value, source_field: members.name},
    ]))
    expect((await mentions()).toSorted()).toEqual([value!, OWNER].sort())
    expect(await repo.query['backlinks.countForBlock'](args).load()).toBe(2)
  })

  it('updates mounted flat backlinks and badge count when a list member moves out', async () => {
    await repo.tx(tx => tx.setProperty(OWNER, members, [TARGET, TARGET]), scope)
    await repo.awaitProcessors()
    const [kept, moved] = await childIds(await fieldFor(members.seedKey))
    expect(kept).toBeDefined()
    expect(moved).toBeDefined()
    const before = await targetEdges()
    expect(before).toHaveLength(3)

    const list = repo.query['backlinks.forBlock'](args)
    const count = repo.query['backlinks.countForBlock'](args)
    const unsubscribeList = list.subscribe(() => {})
    const unsubscribeCount = count.subscribe(() => {})
    try {
      await vi.waitFor(() => {
        expect(list.peek()).toEqual([OWNER])
        expect(count.peek()).toBe(1)
      })
      await repo.tx(tx => tx.move(moved!, {parentId: null, orderKey: 'a4'}), scope)
      await repo.awaitProcessors()
      expect(await targetEdges()).toEqual(before)
      await vi.waitFor(() => {
        expect(list.peek()).toEqual([moved, OWNER])
        expect(count.peek()).toBe(2)
      })
    } finally {
      unsubscribeList()
      unsubscribeCount()
    }
  })

  it('deduplicates a day wikilink until the value is moved out of its field', async () => {
    await repo.tx(async tx => {
      await tx.setProperty(TARGET, aliasesProp, ['Sample target'])
      await tx.setProperty(OWNER, day, TARGET)
    }, scope)
    const field = await fieldFor(day.seedKey)
    const [legacyValue] = await childIds(field)
    await repo.tx(tx => tx.create({
      id: 'named-day', workspaceId: WS, parentId: field, orderKey: 'z1', content: '[[Sample target]]',
    }), scope)
    await repo.awaitProcessors()
    expect((await repo.load('named-day'))?.referenceTargetId).toBe(TARGET)
    expect((await rawMentions()).toSorted()).toEqual([legacyValue!, 'named-day', OWNER].sort())
    const before = await targetEdges()

    const list = repo.query['backlinks.forBlock'](args)
    const count = repo.query['backlinks.countForBlock'](args)
    const unsubscribeList = list.subscribe(() => {})
    const unsubscribeCount = count.subscribe(() => {})
    try {
      await vi.waitFor(() => {
        expect(list.peek()).toEqual([OWNER])
        expect(count.peek()).toBe(1)
      })
      await repo.tx(tx => tx.move('named-day', {parentId: null, orderKey: 'a4'}), scope)
      await repo.awaitProcessors()
      expect(await targetEdges()).toEqual(before)
      await vi.waitFor(() => {
        expect(list.peek()).toEqual(['named-day', OWNER])
        expect(count.peek()).toBe(2)
      })
    } finally {
      unsubscribeList()
      unsubscribeCount()
    }
  })

  it.each(['moves to the root', 'becomes an ordinary block'] as const)(
    'shows the former value when its field %s', async edit => {
      await repo.tx(tx => tx.setProperty(OWNER, related, TARGET), scope)
      const definition = propertyDefinitionBlockId(WS, related.seedKey)
      await repo.tx(tx => tx.createMany([
        {id: 'second-field', workspaceId: WS, parentId: OWNER, orderKey: 'zz', content: `::((${definition}))`},
        {id: 'second-value', workspaceId: WS, parentId: 'second-field', orderKey: 'a0', content: targetRef},
      ]), scope)
      await repo.awaitProcessors()
      const before = await targetEdges()
      expect(before).toHaveLength(3)

      const list = repo.query['backlinks.forBlock'](args)
      const unsubscribe = list.subscribe(() => {})
      try {
        await vi.waitFor(() => expect(list.peek()).toEqual([OWNER]))
        await repo.tx(tx => edit === 'moves to the root'
          ? tx.move('second-field', {parentId: null, orderKey: 'a4'})
          : tx.update('second-field', {content: `((${definition}))`}), scope)
        await repo.awaitProcessors()

        expect(await targetEdges()).toEqual(before)
        await vi.waitFor(() => expect(list.peek()).toEqual(['second-value', OWNER]))
      } finally {
        unsubscribe()
      }
    },
  )
})
