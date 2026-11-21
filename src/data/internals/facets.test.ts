// @vitest-environment node
/**
 * setFacetRuntime + mutatorsFacet integration test (spec §6, §8).
 *
 * Exercises:
 *   - mutatorsFacet.combine returns a Map keyed by mutator name
 *   - duplicate-name registration logs a warning + last-wins
 *   - setFacetRuntime replaces the registry; pre-runtime kernel
 *     registrations DO NOT carry over (the runtime is the snapshot)
 *   - a plugin mutator registered via the runtime is dispatchable via
 *     repo.run('plugin:foo', args) and via repo.mutate['plugin:foo']
 *   - kernelDataExtension contributes kernel property declarations through
 *     definitionSeedsFacet
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createElement, type JSX } from 'react'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  ChangeScope,
  codecs,
  defineMutator,
  definePresetCore,
  definePropertyEditorOverride,
  defineQuery,
  MutatorNotRegisteredError,
  seedType,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '../kernelDataExtension'
import {
  definitionSeedsFacet,
  KERNEL_QUERYABLE_FIELDS,
  mutatorsFacet,
  propertyEditorOverridesFacet,
  queriesFacet,
  queryableFieldsFacet,
  type QueryableField,
  typeSeedsFacet,
  valuePresetCoresFacet,
} from '../facets'
import {
  KERNEL_PROPERTY_SEEDS,
  blockTypeDescriptionProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties'
import { seedProperty } from '@/data/propertySeeds'
import {
  BLOCK_TYPE_TYPE,
  EXTENSION_TYPE,
  KERNEL_TYPE_CONTRIBUTIONS,
  PAGE_TYPE,
  PROPERTY_SCHEMA_TYPE,
  TYPES_PAGE_TYPE,
} from '@/data/blockTypes'
import { Repo } from '../repo'
import { trackTestRepo } from '@/data/test/testRepoScope'

let sharedDb: TestDb
let h: TestDb
let cache: BlockCache
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  h = sharedDb
  cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  repo = trackTestRepo(new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // Mnemonic ids — see the MNEMONIC IDS note in createTestRepo.ts.
    blockIdPolicy: 'any',
    // Start empty so setFacetRuntime is the only registration path.
    installKernelRuntime: false,
  }))
})
afterEach(() => { repo.stopSyncObserver() })

describe('setFacetRuntime + mutatorsFacet', () => {
  it('mutatorsFacet.combine builds a name-keyed map', () => {
    const m1 = defineMutator<{x: number}, void>({
      name: 'plugin:m1',
      argsSchema: z.object({x: z.number()}),
      scope: ChangeScope.BlockDefault,
      apply: async () => {},
    })
    const m2 = defineMutator<{y: string}, void>({
      name: 'plugin:m2',
      argsSchema: z.object({y: z.string()}),
      scope: ChangeScope.BlockDefault,
      apply: async () => {},
    })
    const runtime = resolveFacetRuntimeSync([
      mutatorsFacet.of(m1, {source: 'test'}),
      mutatorsFacet.of(m2, {source: 'test'}),
    ])
    const merged = runtime.read(mutatorsFacet)
    expect(merged.size).toBe(2)
    expect(merged.get('plugin:m1')).toBe(m1)
    expect(merged.get('plugin:m2')).toBe(m2)
  })

  it('duplicate registration logs a warning and last-wins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a = defineMutator<{x: number}, void>({
        name: 'plugin:dup',
        argsSchema: z.object({x: z.number()}),
        scope: ChangeScope.BlockDefault,
        apply: async () => {},
      })
      const b = defineMutator<{x: number}, void>({
        name: 'plugin:dup',
        argsSchema: z.object({x: z.number()}),
        scope: ChangeScope.BlockDefault,
        apply: async () => {},
      })
      const runtime = resolveFacetRuntimeSync([
        mutatorsFacet.of(a, {source: 'test'}),
        mutatorsFacet.of(b, {source: 'test'}),
      ])
      const merged = runtime.read(mutatorsFacet)
      expect(merged.get('plugin:dup')).toBe(b)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('setFacetRuntime replaces the registry — kernel mutators are not implicitly retained', async () => {
    // We started with installKernelRuntime: false, so the registry begins empty.
    // After setFacetRuntime with only a plugin mutator, kernel calls fail.
    let observed = false
    const plugin = defineMutator<{id: string}, void>({
      name: 'plugin:trace',
      argsSchema: z.object({id: z.string()}),
      scope: ChangeScope.BlockDefault,
      apply: async (tx, args) => {
        await tx.create({id: args.id, workspaceId: 'ws-1', parentId: null, orderKey: 'a0'})
        observed = true
      },
    })
    const runtime = resolveFacetRuntimeSync([
      mutatorsFacet.of(plugin, {source: 'test'}),
    ])
    repo.setFacetRuntime(runtime)

    // Plugin mutator dispatches via run + via mutate proxy.
    await repo.run('plugin:trace', {id: 'p1'})
    expect(observed).toBe(true)
    expect(cache.getSnapshot('p1')).toBeDefined()

    observed = false
    await (repo.mutate['plugin:trace'])({id: 'p2'})
    expect(observed).toBe(true)
    expect(cache.getSnapshot('p2')).toBeDefined()

    // Kernel mutator NOT in the runtime — dispatch fails.
    await expect(repo.run('core.setContent', {id: 'p1', content: 'x'}))
      .rejects.toThrow(MutatorNotRegisteredError)
  })
})

describe('queryableFieldsFacet', () => {
  const field: QueryableField = {
    name: 'plugin:score',
    operators: {eq: (_alias, value) => ({sql: '1 = ?', params: [value]})},
    dependencies: [workspaceId => ({kind: 'plugin', channel: 'scores', key: workspaceId})],
  }

  it('resolves a custom field by name and drops malformed contributions', () => {
    const invalid = [
      {...field, name: ''},
      {...field, name: 'no-operators', operators: {}},
      {...field, name: 'unknown-bound', boundingOperators: ['unsupported']},
      {...field, name: 'blank-operator', operators: {' ': field.operators.eq}},
      {...field, name: 'invalid-operator', operators: {eq: 'equals'}},
      {...field, name: 'missing-dependencies', dependencies: undefined},
      {...field, name: 'empty-dependencies', dependencies: []},
      {...field, name: 'invalid-dependencies', dependencies: ['scores']},
    ]
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const runtime = resolveFacetRuntimeSync([
        queryableFieldsFacet.of(field),
        ...invalid.map(value => queryableFieldsFacet.of(value as unknown as QueryableField)),
      ])
      expect(runtime.read(queryableFieldsFacet)).toEqual(new Map([[field.name, field]]))
      expect(error).toHaveBeenCalledTimes(invalid.length)
    } finally {
      error.mockRestore()
    }
  })

  it('keeps the registered field when an invalid runtime contribution has the same name', () => {
    const runtime = resolveFacetRuntimeSync([queryableFieldsFacet.of(field)])
    runtime.setRuntimeContributions(queryableFieldsFacet, 'plugin', [
      {...field, dependencies: []} as unknown as QueryableField,
    ])
    expect(runtime.read(queryableFieldsFacet).get(field.name)).toBe(field)
  })
})

describe('kernel queryable timestamps', () => {
  const [created, updated] = KERNEL_QUERYABLE_FIELDS
  const leapDay = Date.UTC(2024, 1, 29)

  it('binds milliseconds, Dates and canonical strings as timestamp parameters', () => {
    for (const operand of [leapDay, new Date(leapDay), '2024-02-29T00:00:00.000Z', '2024-02-29']) {
      expect(created.operators.eq('candidate', operand)).toEqual({
        sql: 'candidate.created_at = ?',
        params: [leapDay],
      })
    }
    expect(updated.operators.between('candidate', [leapDay, '2024-03-01'])).toEqual({
      sql: 'coalesce(candidate.user_updated_at, candidate.updated_at) BETWEEN ? AND ?',
      params: [leapDay, Date.UTC(2024, 2, 1)],
    })
  })

  it('rejects normalized calendar dates and invalid operands', () => {
    for (const operand of [Infinity, new Date(NaN), '2023-02-29', '2024-02-30T00:00:00.000Z', '2024-2-9']) {
      expect(() => created.operators.eq('candidate', operand)).toThrow('timestamp operand')
    }
    expect(() => updated.operators.between('candidate', [leapDay])).toThrow('two timestamp operands')
    expect(() => updated.operators.between('candidate', [leapDay, '2024-02-30'])).toThrow('timestamp operand')
  })
})

describe('kernel property declaration registration', () => {
  it('kernelDataExtension contributes every kernel entry as a definition seed', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    expect(runtime.read(definitionSeedsFacet)).toEqual(KERNEL_PROPERTY_SEEDS)
  })
})

describe('type seed registration', () => {
  it('kernelDataExtension contributes kernel block types as seeds', () => {
    // Kernel types are code seeds — they register into `typeSeedsFacet` (a list
    // facet the materializer reads); the static `typesFacet` path is gone (D).
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    const registered = runtime.read(typeSeedsFacet)
    expect(registered.length).toBe(KERNEL_TYPE_CONTRIBUTIONS.length)
    const byId = new Map(registered.map(t => [t.id, t]))
    for (const type of KERNEL_TYPE_CONTRIBUTIONS) {
      expect(byId.get(type.id)).toBe(type)
    }
  })

  it('Extension blocks carry name and description metadata properties', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    const extensionType = runtime.read(typeSeedsFacet).find(t => t.id === EXTENSION_TYPE)

    expect(extensionType?.properties).toEqual(
      expect.arrayContaining([extensionNameProp, extensionDescriptionProp]),
    )
  })

  it('block-type kernel contribution surfaces label, description, and properties props', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    repo.setFacetRuntime(runtime)
    const blockType = repo.types.get(BLOCK_TYPE_TYPE)
    expect(blockType).toBeDefined()
    expect(blockType!.properties).toEqual(
      expect.arrayContaining([blockTypeLabelProp, blockTypeDescriptionProp, blockTypePropertiesProp]),
    )
    expect(repo.propertySchemas.get(blockTypeLabelProp.name)).toBe(blockTypeLabelProp)
    expect(repo.propertySchemas.get(blockTypeDescriptionProp.name)).toBe(blockTypeDescriptionProp)
    expect(repo.propertySchemas.get(blockTypePropertiesProp.name)).toBe(blockTypePropertiesProp)
  })

  it('block-type:properties prop is a refList scoped to property-schema target type', () => {
    expect(blockTypePropertiesProp.codec.type).toBe('refList')
    const codec = blockTypePropertiesProp.codec as ReturnType<typeof codecs.refList>
    expect(codec.targetTypes).toEqual([PROPERTY_SCHEMA_TYPE])
  })

  it('Types page marker block-type is registered as a kernel type', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    repo.setFacetRuntime(runtime)
    expect(repo.types.has(TYPES_PAGE_TYPE)).toBe(true)
  })

  it('surfaces kernel type seeds in repo.types BEFORE a workspace pin (buildUnboundTypes fallback)', () => {
    // No setActiveWorkspaceId: the type-definition registry is null, so repo.types
    // must fall back to the unbound seed synthesis. Direct regression guard for the
    // move of kernel types onto `typeSeedsFacet` — without the fallback, `repo.types`
    // would be empty until a workspace pins the registry.
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    repo.setFacetRuntime(runtime)
    expect(repo.activeWorkspaceId).toBeNull()
    expect(repo.types.get(PAGE_TYPE)?.label).toBe('Page')
    // The synthesized contribution is provenance-stripped (seedContribution) —
    // the seed's seedKey/revision don't leak into `repo.types`.
    expect(repo.types.get(PAGE_TYPE)).not.toHaveProperty('seedKey')
    expect(repo.types.get(PAGE_TYPE)).not.toHaveProperty('revision')
  })
})

describe('valuePresetCoresFacet', () => {
  it('keys cores by id and last-wins on collision', () => {
    const first = definePresetCore<string>({
      id: 'string',
      build: () => codecs.string,
      defaultValue: 'first',
    })
    const second = definePresetCore<string>({
      id: 'string',
      build: () => codecs.string,
      defaultValue: 'second',
    })
    const runtime = resolveFacetRuntimeSync([
      valuePresetCoresFacet.of(first, {source: 'test'}),
      valuePresetCoresFacet.of(second, {source: 'test'}),
    ])
    expect(runtime.read(valuePresetCoresFacet).get('string')?.defaultValue).toBe('second')
  })
})

describe('facet variance — typed plugin contributions register without widening', () => {
  // Prior to AnyQuery / AnyPropertyEditorOverride / AnyPropertySchema,
  // typed plugin contributions failed to register because the facet's
  // contribution type (`Query<unknown, unknown>` / `PropertyEditorOverride<unknown>`
  // / `PropertySchema<unknown>`) is contravariant in the parameter and so a typed
  // plugin shape couldn't be assigned. These tests pin the variance escape.

  it('queriesFacet accepts a typed plugin Query<{x:number}, string>', () => {
    const typedQuery = defineQuery<{x: number}, string>({
      name: 'plugin:typedQuery',
      argsSchema: z.object({x: z.number()}),
      resultSchema: z.string(),
      resolve: async ({x}, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return String(x)
      },
    })
    const runtime = resolveFacetRuntimeSync([
      queriesFacet.of(typedQuery, {source: 'plugin'}),
    ])
    const registered = runtime.read(queriesFacet)
    expect(registered.get('plugin:typedQuery')).toBe(typedQuery)
  })

  it('propertyEditorOverridesFacet accepts a typed PropertyEditorOverride<Date | undefined>', () => {
    const dueDateProp = seedProperty({
      seedKey: 'system:test-plugin/property/due-date',
      revision: 1,
      name: 'tasks:due-date',
      preset: 'date',
      changeScope: ChangeScope.BlockDefault,
    })
    const typedUi = definePropertyEditorOverride(dueDateProp, {
      label: 'Due date',
      Editor: (): JSX.Element => createElement('span', null, null),
    })
    const runtime = resolveFacetRuntimeSync([
      propertyEditorOverridesFacet.of(typedUi, {source: 'plugin'}),
    ])
    const registered = runtime.read(propertyEditorOverridesFacet)
    expect(registered.get(dueDateProp.seedKey)).toBe(typedUi)
  })
})

describe('Repo.onTypesChange', () => {
  // Symmetric to onPropertySchemasChange / onValuePresetsChange. Fires
  // when the rebuild step republishes the merged `_types` map — used by
  // user-types adoption flows (e.g. createTypeBlock's commit→
  // registration handoff) to bridge between txs without polling.

  it('fires when setRuntimeContributions publishes into the typeSeedsFacet user-data bucket', () => {
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    let calls = 0
    repo.onTypesChange(() => { calls++ })
    repo.setRuntimeContributions(typeSeedsFacet, 'user-data', [
      seedType({seedKey: 'test/type/user-defined-type-1', revision: 1, id: 'user-defined-type-1', label: 'User type 1'}),
    ])
    expect(calls).toBe(1)
    // The published contribution is the provenance-stripped seed synthesis.
    expect(repo.types.get('user-defined-type-1')).toMatchObject({id: 'user-defined-type-1', label: 'User type 1'})
  })

  it('fires when setFacetRuntime swaps in a runtime with new type contributions', () => {
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    let calls = 0
    repo.onTypesChange(() => { calls++ })
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      typeSeedsFacet.of(seedType({seedKey: 'test/type/extra-type', revision: 1, id: 'extra-type', label: 'Extra'}), {source: 'test'}),
    ]))
    expect(calls).toBeGreaterThan(0)
    expect(repo.types.get('extra-type')).toMatchObject({id: 'extra-type', label: 'Extra'})
  })

  it('disposer prevents subsequent notifications', () => {
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    let calls = 0
    const dispose = repo.onTypesChange(() => { calls++ })
    dispose()
    repo.setRuntimeContributions(typeSeedsFacet, 'user-data', [
      seedType({seedKey: 'test/type/a-type', revision: 1, id: 'a-type', label: 'A'}),
    ])
    expect(calls).toBe(0)
  })
})
