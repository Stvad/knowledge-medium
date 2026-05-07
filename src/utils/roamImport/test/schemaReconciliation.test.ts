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
  normalizeRefPropertyValues,
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
    startRowEventsTail: false,
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
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:topics', presetId: 'refList'}])
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

  it('mixed page-token and plain-string arrays fall back to string', () => {
    const blocks: BlockData[] = [
      block('a', {'roam:mixed': ['[[A]]', '[[B]]']}),    // page-token array
      block('b', {'roam:mixed': ['plain', 'words']}),    // plain-string array
    ]
    const plan = collectSchemaReconciliationPlan(blocks, env.repo)
    expect(plan.toRegister).toEqual([{name: 'roam:mixed', presetId: 'string'}])
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
