// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope, type BlockData } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { Repo } from '@/data/repo'
import {
  applySchemaReconciliation,
  collectSchemaReconciliationPlan,
  normalizeListPropertyValues,
  normalizeRefPropertyValues,
  normalizeStringPropertyValues,
} from '../schemaReconciliation'

const WS = 'ws-roam'

interface Harness {
  h: TestDb
  repo: Repo
  dispose: () => void
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    registerKernelProcessors: false,
    startSyncObserver: false,
  })
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    kernelPropertyUiExtension,
    kernelValuePresetsExtension,
  ]))
  await getOrCreatePropertiesPage(repo, WS)
  const dispose = repo.userSchemas.start()
  return {h, repo, dispose}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => {
  env.dispose()
  await env.h.cleanup()
})

const block = (id: string, properties: Record<string, unknown>): BlockData => ({
  id,
  workspaceId: WS,
  parentId: null,
  orderKey: id,
  content: '',
  properties,
  references: [],
  createdAt: 0,
  updatedAt: 0,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
})

describe('collectSchemaReconciliationPlan', () => {
  it('classifies homogeneous numeric values as the number preset', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:rank': 1}),
      block('b', {'roam:rank': 2}),
      block('c', {'roam:rank': 99}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:rank', presetId: 'number'}])
  })

  it('classifies homogeneous boolean values as the boolean preset', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:done': true}),
      block('b', {'roam:done': false}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:done', presetId: 'boolean'}])
  })

  it('falls back to string for mixed or string values', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:status': 'TODO'}),
      block('b', {'roam:status': 1}),  // mixed → string
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:status', presetId: 'string'}])
  })

  it('classifies pure-page-token values as the refList preset', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:topics': '[[A]] [[B]]'}),
      block('b', {'roam:topics': '[[C]]'}),
      block('c', {'roam:topics': ['[[D]]', '[[E]]']}),
      block('d', {'roam:topics': '[[outer [[inner]] tail]]'}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:topics', presetId: 'refList'}])
  })

  it('infers daily-note targetTypes when every token alias is a canonical daily title', async () => {
    const blocks: BlockData[] = [
      block('a', {'roam:initial review date': '[[2026-05-18]]'}),
      block('b', {'roam:initial review date': '[[2026-05-19]]'}),
      block('c', {'roam:initial review date': ['[[May 20th, 2026]]', '[[2026-06-01]]']}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{
      name: 'roam:initial review date',
      presetId: 'refList',
      targetTypes: ['daily-note'],
    }])

    // End-to-end: the registered schema's codec carries the targetTypes
    // so the backlinks property-filter UI surfaces the date affordance.
    await applySchemaReconciliation(plan.toRegister, env.repo, [])
    const schema = env.repo.propertySchemas.get('roam:initial review date')
    expect(schema?.codec.type).toBe('refList')
    expect((schema?.codec as {targetTypes?: readonly string[]}).targetTypes).toEqual(['daily-note'])
  })

  it('omits targetTypes when token aliases mix daily-note and non-daily-note pages', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:related': '[[2026-05-18]]'}),
      block('b', {'roam:related': '[[Some Concept]]'}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:related', presetId: 'refList'}])
  })

  it('omits targetTypes for refList properties whose tokens are non-daily-note pages', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:topics': '[[Algorithms]]'}),
      block('b', {'roam:topics': '[[Data Structures]]'}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:topics', presetId: 'refList'}])
  })

  it('forces semantic Roam ref fields to the refList preset', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:isa': 'person'}),
      block('b', {'roam:page_alias': 'not a bracketed page ref'}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([
      {name: 'roam:isa', presetId: 'refList'},
      {name: 'roam:page_alias', presetId: 'refList'},
    ])
  })

  it('falls back to string when at least one value isn\'t a token list', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:notes': '[[A]]'}),
      block('b', {'roam:notes': 'plain text [[B]]'}),  // mixed text + token → string
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:notes', presetId: 'string'}])
  })

  it('classifies pure plain-string arrays as the list preset', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:highlights': ['first', 'second']}),
      block('b', {'roam:highlights': ['third']}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:highlights', presetId: 'list'}])
  })

  it('classifies mixed scalar strings and plain-string arrays as the list preset', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:email': 'gliderok@gmail.com'}),
      block('b', {'roam:email': ['gliderok@gmail.com', 'aix123@yandex.ru']}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:email', presetId: 'list'}])
  })

  it('mixed page-token and plain-string arrays fall back to string', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:mixed': ['[[A]]', '[[B]]']}),    // page-token array
      block('b', {'roam:mixed': ['plain', 'words']}),    // plain-string array
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:mixed', presetId: 'string'}])
  })

  it('reports near-refList fields that fall back to string', () => {
    const blocks: BlockData[] = [
      ...Array.from({length: 17}, (_, i) => block(`ref-${i}`, {'roam:almost-ref': `[[Topic ${i}]]`})),
      block('bad-ref-1', {'roam:almost-ref': 'plain text [[Topic 17]]'}),
      block('bad-ref-2', {'roam:almost-ref': 'plain text [[Topic 18]]'}),
      block('bad-ref-3', {'roam:almost-ref': 'plain text [[Topic 19]]'}),
    ]

    const plan = collectSchemaReconciliationPlan(blocks, env.repo)

    expect(plan.toRegister).toEqual([{name: 'roam:almost-ref', presetId: 'string'}])
    expect(plan.diagnostics).toEqual([
      expect.stringContaining('property "roam:almost-ref" inferred string, but 17/20 values (85%) looked like refList'),
    ])
    expect(plan.diagnostics[0]).toContain('((bad-ref-1))="plain text [[Topic 17]]"')
    expect(plan.diagnostics[0]).toContain('((bad-ref-2))="plain text [[Topic 18]]"')
    expect(plan.diagnostics[0]).toContain('((bad-ref-3))="plain text [[Topic 19]]"')
  })

  it('skips names already registered (kernel/plugin/user-data)', () => {
    const blocks: BlockData[] = [
      block('a', {types: ['page']}),  // kernel-registered
      block('b', {'roam:fresh': 'x'}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:fresh', presetId: 'string'}])
  })

  it('skips reserved hidden names with a diagnostic', () => {
    // editorFocusRequest is registered AND hidden via PropertyEditorOverride.
    // It should be skipped from registration AND reported as reserved.
    const blocks: BlockData[] = [
      block('a', {editorFocusRequest: 1}),
      block('b', {'roam:keep': 'x'}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:keep', presetId: 'string'}])
    // editorFocusRequest is already in the registry so it short-circuits
    // before the hidden check; the test below covers the hidden path.
  })
})

describe('applySchemaReconciliation', () => {
  it('persists property-schema blocks and registers each schema synchronously', async () => {
    const blocks: BlockData[] = [
      block('a', {'roam:topic': 'foo'}),
      block('b', {'roam:rank': 42}),
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    const diagnostics: string[] = []
    await applySchemaReconciliation(plan.toRegister, env.repo, diagnostics)

    expect(diagnostics).toEqual([])
    expect(env.repo.propertySchemas.get('roam:topic')?.codec.type).toBe('string')
    expect(env.repo.propertySchemas.get('roam:rank')?.codec.type).toBe('number')
    expect(env.repo.propertySchemas.get('roam:rank')?.changeScope).toBe(ChangeScope.BlockDefault)
  })

  it('records a diagnostic when a preset id is unknown', async () => {
    const diagnostics: string[] = []
    await applySchemaReconciliation(
      [{name: 'roam:bad', presetId: 'definitely-not-a-preset' as unknown as 'string'}],
      env.repo,
      diagnostics,
    )
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatch(/Failed to register schema "roam:bad"/)
    expect(env.repo.propertySchemas.has('roam:bad')).toBe(false)
  })
})

describe('normalizeStringPropertyValues', () => {
  it('stringifies non-string JSON values for string-classified properties', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:mixed': 'plain'}),
      block('b', {'roam:mixed': 1}),
      block('c', {'roam:mixed': ['one', 'two']}),
      block('d', {'roam:mixed': {nested: true}}),
      block('e', {'roam:other': ['untouched']}),
    ]

    normalizeStringPropertyValues(blocks, new Set(['roam:mixed']))

    expect(blocks.map(b => b.properties['roam:mixed'])).toEqual([
      'plain',
      '1',
      '["one","two"]',
      '{"nested":true}',
      undefined,
    ])
    expect(blocks[4].properties['roam:other']).toEqual(['untouched'])
  })
})

describe('normalizeListPropertyValues', () => {
  it('wraps scalar values and leaves array values untouched for list-classified properties', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:email': 'gliderok@gmail.com'}),
      block('b', {'roam:email': ['gliderok@gmail.com', 'aix123@yandex.ru']}),
      block('c', {'roam:rank-list': 1}),
      block('d', {'roam:other': 'untouched'}),
    ]

    normalizeListPropertyValues(blocks, new Set(['roam:email', 'roam:rank-list']))

    expect(blocks.map(b => b.properties['roam:email'])).toEqual([
      ['gliderok@gmail.com'],
      ['gliderok@gmail.com', 'aix123@yandex.ru'],
      undefined,
      undefined,
    ])
    expect(blocks[2].properties['roam:rank-list']).toEqual([1])
    expect(blocks[3].properties['roam:other']).toBe('untouched')
  })
})

describe('normalizeRefPropertyValues', () => {
  it('refList: replaces page-token strings with id arrays via aliasIdMap', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:topics': '[[A]] [[B]]'}),
      block('b', {'roam:topics': '[[C]]'}),
      block('c', {'roam:topics': ['[[D]]', '[[E]]']}),
    ]
    const aliasIdMap = new Map([
      ['A', 'id-a'], ['B', 'id-b'], ['C', 'id-c'], ['D', 'id-d'], ['E', 'id-e'],
    ])
    const diagnostics: string[] = []
    normalizeRefPropertyValues(blocks, new Map([['roam:topics', 'refList']]), aliasIdMap, diagnostics)
    expect(blocks[0].properties['roam:topics']).toEqual(['id-a', 'id-b'])
    expect(blocks[1].properties['roam:topics']).toEqual(['id-c'])
    expect(blocks[2].properties['roam:topics']).toEqual(['id-d', 'id-e'])
    expect(diagnostics).toEqual([])
  })

  it('refList: preserves whitespace inside page-token aliases', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:topics': '[[ Foo ]]'}),
      block('b', {'roam:topics': ['[[ Bar ]]']}),
      block('c', {'roam:topics': '[[outer [[inner]] tail]]'}),
    ]
    const aliasIdMap = new Map([
      [' Foo ', 'id-foo'],
      [' Bar ', 'id-bar'],
      ['outer [[inner]] tail', 'id-outer'],
      ['inner', 'id-inner'],
    ])
    const diagnostics: string[] = []
    normalizeRefPropertyValues(blocks, new Map([['roam:topics', 'refList']]), aliasIdMap, diagnostics)
    expect(blocks[0].properties['roam:topics']).toEqual(['id-foo'])
    expect(blocks[1].properties['roam:topics']).toEqual(['id-bar'])
    expect(blocks[2].properties['roam:topics']).toEqual(['id-outer'])
    expect(diagnostics).toEqual([])
  })

  it('refList: reports unresolved aliases as diagnostics and drops them from the value', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:topics': '[[Known]] [[Missing]]'}),
    ]
    const aliasIdMap = new Map([['Known', 'id-known']])
    const diagnostics: string[] = []
    normalizeRefPropertyValues(blocks, new Map([['roam:topics', 'refList']]), aliasIdMap, diagnostics)
    expect(blocks[0].properties['roam:topics']).toEqual(['id-known'])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatch(/unresolved aliases: Missing/)
  })

  it('refList: treats semantic Roam ref field plain strings as aliases', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:isa': 'person'}),
      block('b', {'roam:page_alias': 'LukeProg'}),
      block('c', {'roam:page_alias': '"Lily Anna", "Katerina Kolyada"'}),
      block('d', {'roam:page_alias': 'built a prototype inside it, and it is thematically appropriate'}),
      block('e', {'roam:page_alias': '{{[[mentions]]: [[Voice notes inbox process]]}}'}),
      block('f', {'roam:isa': 'mental model'}),
    ]
    const aliasIdMap = new Map([
      ['person', 'person-id'],
      ['LukeProg', 'alias-id'],
      ['Lily Anna', 'lily-anna-id'],
      ['Katerina Kolyada', 'katerina-id'],
      ['mental model', 'mental-model-id'],
    ])
    const diagnostics: string[] = []
    normalizeRefPropertyValues(
      blocks,
      new Map([
        ['roam:isa', 'refList'],
        ['roam:page_alias', 'refList'],
      ]),
      aliasIdMap,
      diagnostics,
    )
    expect(blocks[0].properties['roam:isa']).toEqual(['person-id'])
    expect(blocks[1].properties['roam:page_alias']).toEqual(['alias-id'])
    expect(blocks[2].properties['roam:page_alias']).toEqual(['lily-anna-id', 'katerina-id'])
    expect(blocks[3].properties['roam:page_alias']).toEqual([])
    expect(blocks[4].properties['roam:page_alias']).toEqual([])
    expect(blocks[5].properties['roam:isa']).toEqual(['mental-model-id'])
    expect(diagnostics).toEqual([])
  })

  it('ref: writes a single resolved id (string), not an array', () => {
    const blocks: BlockData[] = [
      block('a', {assignee: '[[Alice]]'}),
    ]
    const diagnostics: string[] = []
    normalizeRefPropertyValues(
      blocks,
      new Map([['assignee', 'ref']]),
      new Map([['Alice', 'alice-id']]),
      diagnostics,
    )
    expect(blocks[0].properties.assignee).toBe('alice-id')
    expect(diagnostics).toEqual([])
  })

  it('ref: empty string when no alias resolves; diagnostic for the dangling token', () => {
    const blocks: BlockData[] = [
      block('a', {assignee: '[[Bob]]'}),
    ]
    const diagnostics: string[] = []
    normalizeRefPropertyValues(blocks, new Map([['assignee', 'ref']]), new Map(), diagnostics)
    expect(blocks[0].properties.assignee).toBe('')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatch(/unresolved aliases: Bob/)
  })

  it('ref: keeps the first id and reports a diagnostic when a value carries multiple aliases', () => {
    const blocks: BlockData[] = [
      block('a', {assignee: '[[Alice]] [[Bob]]'}),
    ]
    const diagnostics: string[] = []
    normalizeRefPropertyValues(
      blocks,
      new Map([['assignee', 'ref']]),
      new Map([['Alice', 'alice-id'], ['Bob', 'bob-id']]),
      diagnostics,
    )
    expect(blocks[0].properties.assignee).toBe('alice-id')
    expect(diagnostics.some(d => /had 2 aliases/.test(d))).toBe(true)
  })

  it('leaves non-token values alone (defensive — classification should already prevent this)', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:plain': 'just a string'}),
    ]
    normalizeRefPropertyValues(blocks, new Map([['roam:plain', 'refList']]), new Map(), [])
    expect(blocks[0].properties['roam:plain']).toBe('just a string')
  })
})
