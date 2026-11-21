// @vitest-environment happy-dom
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {definitionProp, EXERCISE_DEF_TYPE} from '../../../../agent-extensions/strength-tracker/src/km/schema'
import {ChangeScope, codecs, definePresetCore, seedProperty} from '@/data/api'
import {materializePropertySeeds, propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {definitionSeedsFacet, valuePresetCoresFacet} from '@/data/facets'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {bindExtensionPropertySeed} from '@/extensions/dynamicExtensionSeeds'
import {staticAppExtensions} from '@/extensions/staticAppExtensions'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {blockTagsConfigProp} from '@/plugins/block-tagging/config'
import {videoNotesPaneRatioProp} from '@/plugins/video-player/view'
import type {AppExtension} from '@/facets/facet'
import {resolveAppRuntimeSync} from '@/facets/resolveAppRuntime'
import {createAgentRuntimeContext, executeCommand} from '../commands'
import type {AgentRuntimeContext} from '../protocol'
import {createTestAgentContext} from './createTestAgentContext'

const WS = 'workspace'
// No app-only static seed uses a ref codec. Bind the installed extension declaration as its loader would.
const ref = bindExtensionPropertySeed({...definitionProp}, crypto.randomUUID())
const targets = [crypto.randomUUID(), crypto.randomUUID()] as const
const samples = [
  {seed: ref, first: targets[0], next: targets[1]},
  {seed: videoNotesPaneRatioProp, first: 0.375, next: 0.625},
  {seed: blockTagsConfigProp, first: ['red', 'blue'], next: ['green', 'blue']},
]

let shared: TestDb
beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => { await resetTestDb(shared.db) })

const open = (device: 'tab' | 'host', extra: AppExtension = []) => {
  const {repo} = createTestRepo({db: shared.db, appGenerators: true})
  if (device === 'host') return createTestAgentContext(repo, WS, staticDataExtensions)
  const runtime = resolveAppRuntimeSync([
    ...staticAppExtensions({repo}),
    ...staticDataExtensions,
    definitionSeedsFacet.of(ref, {source: 'test-extension'}),
    extra,
  ], {overrides: new Map(), safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  return createAgentRuntimeContext({repo, runtime, safeMode: false})
}

const insertWorkspace = (mode: 'cell' | 'children') => shared.db.execute(
  `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
   VALUES (?, 'test', 'test-user', 1, 1, 'none', ?)`, [WS, mode])

const count = async () => (await shared.db.get<{n: number}>('SELECT count(*) AS n FROM blocks')).n

const stored = async (id: string) => {
  const owner = await shared.db.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [id])
  const rows = await shared.db.getAll(
    `SELECT f.content AS field, v.content AS value, f.reference_target_id AS fieldTarget, f.is_field_form AS isField,
            v.reference_target_id AS valueTarget
     FROM blocks f LEFT JOIN blocks v ON v.parent_id = f.id AND v.deleted = 0
     WHERE f.parent_id = ? AND f.deleted = 0 ORDER BY f.order_key, v.order_key`, [id])
  const refs = await shared.db.getAll(
    'SELECT target_id, alias, source_field FROM block_references WHERE source_id = ? ORDER BY target_id', [id])
  return {bag: JSON.parse(owner.properties_json), rows, refs}
}

const create = async (ctx: AgentRuntimeContext, id: string, properties?: Record<string, unknown>) => {
  await executeCommand({commandId: 'test', contributorId: null, type: 'create-block', data: {id}, properties}, ctx)
  await ctx.repo.awaitProcessors()
}
const update = async (ctx: AgentRuntimeContext, id: string, properties: Record<string, unknown>) => {
  await executeCommand({commandId: 'test', contributorId: null, type: 'update-block', id, properties}, ctx)
  await ctx.repo.awaitProcessors()
}

describe.each(['children', 'cell'] as const)('%s storage with a synced definition', mode => {
  it.each(samples)('$seed.name through create-block and update-block', async ({seed, first, next}) => {
    await insertWorkspace(mode)
    const tab = open('tab')
    const name = seed.name
    const fieldId = propertyDefinitionBlockId(WS, seed.seedKey)
    expect(tab.repo.propertySchemas.get(name)).toBe(seed)
    await materializePropertySeeds(tab.repo, WS, [seed])
    if (seed === ref) {
      for (const target of targets) await create(tab, target)
    }
    const tabId = crypto.randomUUID()
    const hostId = crypto.randomUUID()

    const expected = (value: typeof first) => ({
      bag: {[name]: value},
      rows: mode === 'cell' ? [] : [{
        field: `::((${fieldId}))`, fieldTarget: fieldId, isField: 1,
        value: seed === ref ? `((${value}))` : JSON.stringify(value),
        valueTarget: seed === ref ? value : null,
      }],
      refs: seed === ref ? [{source_field: name, target_id: value, alias: value}] : [],
    })
    const createCount = mode === 'children' ? 3 : 1
    const baseline = await count()
    await create(tab, tabId, {[name]: first})
    expect(await stored(tabId)).toEqual(expected(first))
    expect(await count()).toBe(baseline + createCount)

    await update(tab, tabId, {[name]: next})
    const updated = await stored(tabId)
    expect(updated).toEqual(expected(next))
    const afterTab = await count()
    expect(afterTab).toBe(baseline + createCount)
    tab.repo.setActiveWorkspaceId(null)
    const host = open('host')
    await host.repo.whenPropertyDefinitionsReady(WS)
    const registry = host.repo.propertyDefinitions!
    expect(registry.seedsByKey.has(seed.seedKey)).toBe(false)
    expect(registry.definitionsByName.get(name)?.map(row => row.fieldId)).toEqual([fieldId])
    const read = await executeCommand({type: 'get-block', commandId: 'read', id: tabId}, host)
    expect(read).toMatchObject({properties: {[name]: next}})
    if (mode === 'children' && seed === blockTagsConfigProp) {
      expect(host.repo.propertySchemas.get(name)).toBeUndefined()
      const refusal = {schemaName: name, reason: 'behavior-unavailable'}
      await expect(create(host, hostId, {[name]: first})).rejects.toMatchObject(refusal)
      await expect(update(host, tabId, {[name]: first})).rejects.toMatchObject(refusal)
      expect(await stored(tabId)).toEqual(expected(next))
      expect(await count()).toBe(afterTab)
      return
    }
    await create(host, hostId, {[name]: first})
    expect(await stored(hostId)).toEqual(expected(first))
    expect(await count()).toBe(afterTab + createCount)
    await update(host, hostId, {[name]: next})
    expect(await stored(hostId)).toEqual(updated)
    expect(await count()).toBe(afterTab + createCount)

    const hostSchema = host.repo.propertySchemas.get(name)
    if (seed === blockTagsConfigProp) {
      expect(hostSchema).toBeUndefined()
    } else {
      expect(hostSchema?.codec.type).toBe(seed.codec.type)
      expect(host.repo.block(tabId).get(hostSchema!)).toEqual(next)
      if (seed === ref) {
        expect(hostSchema!.codec).toMatchObject({targetTypes: [EXERCISE_DEF_TYPE]})
        expect(hostSchema!.codec.decode(null)).toBeUndefined()
      }
    }
  })
})

it('known gap: a cell write with an unavailable custom ref preset loses the property backlink', async () => {
  await insertWorkspace('cell')
  const preset = definePresetCore<string>({id: 'sample:reference', build: () => codecs.ref(), defaultValue: ''})
  const seed = seedProperty({
    seedKey: 'sample/property/target', revision: 1, name: 'sample:target',
    preset, defaultValue: '', changeScope: ChangeScope.BlockDefault,
  })
  const tab = open('tab', [
    definitionSeedsFacet.of(seed, {source: 'sample'}),
    valuePresetCoresFacet.of(preset, {source: 'sample'}),
  ])
  await materializePropertySeeds(tab.repo, WS, [seed])
  for (const target of targets) await create(tab, target)
  const id = crypto.randomUUID()
  const hostId = crypto.randomUUID()
  const input = {[seed.name]: targets[0]}
  await create(tab, id, input)
  const tabRows = await stored(id)
  expect(tabRows).toEqual({bag: input, rows: [], refs: [
    {target_id: targets[0], alias: targets[0], source_field: seed.name},
  ]})
  const next = {[seed.name]: targets[1]}
  await update(tab, id, next)
  expect(await stored(id)).toEqual({bag: next, rows: [], refs: [
    {target_id: targets[1], alias: targets[1], source_field: seed.name},
  ]})
  tab.repo.setActiveWorkspaceId(null)

  const host = open('host')
  await host.repo.whenPropertyDefinitionsReady(WS)
  const fieldId = propertyDefinitionBlockId(WS, seed.seedKey)
  expect(host.repo.propertyDefinitions?.definitionsByName.get(seed.name)?.map(row => row.fieldId)).toEqual([fieldId])
  expect(host.repo.propertySchemaResolverFor(WS).resolve(seed.name)).toEqual({
    status: 'identity-unavailable', reason: 'behavior-unavailable',
  })
  const before = await count()
  await create(host, hostId, input)
  expect(await stored(hostId)).toEqual({bag: input, rows: [], refs: []})
  await update(host, id, input)
  expect(await stored(id)).toEqual({bag: input, rows: [], refs: []})
  expect(await count()).toBe(before + 1)
})
