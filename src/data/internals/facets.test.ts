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
 *   - kernelDataExtension contributes kernel property schemas through
 *     propertySchemasFacet (Phase 3 — chunk A)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createElement, type JSX } from 'react'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineMutator,
  definePreset,
  defineProperty,
  definePropertyEditorOverride,
  defineQuery,
  MutatorNotRegisteredError,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '../kernelDataExtension'
import {
  mutatorsFacet,
  propertyEditorOverridesFacet,
  propertySchemasFacet,
  queriesFacet,
  typesFacet,
  valuePresetsFacet,
} from '../facets'
import {
  KERNEL_PROPERTY_SCHEMAS,
  blockTypeDescriptionProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties'
import {
  BLOCK_TYPE_TYPE,
  EXTENSION_TYPE,
  KERNEL_TYPE_CONTRIBUTIONS,
  PROPERTY_SCHEMA_TYPE,
  TYPES_PAGE_TYPE,
} from '@/data/blockTypes'
import { Repo } from '../repo'

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
  repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // Start empty so setFacetRuntime is the only registration path.
    registerKernelMutators: false,
    registerKernelProcessors: false,
  })
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
    // We started with registerKernelMutators: false, so the registry begins empty.
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

describe('propertySchemasFacet — kernel registration', () => {
  it('kernelDataExtension contributes every KERNEL_PROPERTY_SCHEMAS entry', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    const registered = runtime.read(propertySchemasFacet)
    expect(registered.size).toBe(KERNEL_PROPERTY_SCHEMAS.length)
    for (const schema of KERNEL_PROPERTY_SCHEMAS) {
      // Identity-equal: facet stores the same instance.
      expect(registered.get(schema.name)).toBe(schema)
    }
  })

  it('plugin schema layered onto kernel coexists by name', () => {
    const pluginSchema = defineProperty<string | undefined>('plugin:foo', {
      codec: codecs.optionalString,
      defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
    })
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      propertySchemasFacet.of(pluginSchema, {source: 'plugin'}),
    ])
    const registered = runtime.read(propertySchemasFacet)
    expect(registered.get('plugin:foo')).toBe(pluginSchema)
    // Kernel entries still present.
    for (const schema of KERNEL_PROPERTY_SCHEMAS) {
      expect(registered.get(schema.name)).toBe(schema)
    }
  })

  it('duplicate-name registration logs a warning and last-wins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a = defineProperty<string | undefined>('plugin:dup', {
        codec: codecs.optionalString,
        defaultValue: undefined,
        changeScope: ChangeScope.BlockDefault,
      })
      const b = defineProperty<string | undefined>('plugin:dup', {
        codec: codecs.optionalString,
        defaultValue: undefined,
        changeScope: ChangeScope.BlockDefault,
      })
      const runtime = resolveFacetRuntimeSync([
        propertySchemasFacet.of(a, {source: 'test'}),
        propertySchemasFacet.of(b, {source: 'test'}),
      ])
      const registered = runtime.read(propertySchemasFacet)
      expect(registered.get('plugin:dup')).toBe(b)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('typesFacet + schema lift', () => {
  it('typesFacet combines contributions by id with last-wins warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a = defineBlockType({id: 'task', label: 'Task A'})
      const b = defineBlockType({id: 'task', label: 'Task B'})
      const runtime = resolveFacetRuntimeSync([
        typesFacet.of(a, {source: 'test'}),
        typesFacet.of(b, {source: 'test'}),
      ])
      const registered = runtime.read(typesFacet)
      expect(registered.get('task')).toBe(b)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('kernelDataExtension contributes kernel block types', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    const registered = runtime.read(typesFacet)
    expect(registered.size).toBe(KERNEL_TYPE_CONTRIBUTIONS.length)
    for (const type of KERNEL_TYPE_CONTRIBUTIONS) {
      expect(registered.get(type.id)).toBe(type)
    }
  })

  it('Extension blocks lift name and description metadata properties', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension])
    const registered = runtime.read(typesFacet)
    const extensionType = registered.get(EXTENSION_TYPE)

    expect(extensionType?.properties).toEqual(
      expect.arrayContaining([extensionNameProp, extensionDescriptionProp]),
    )
  })

  it('Repo exposes schemas lifted from type contributions', () => {
    const liftedSchema = defineProperty<string>('task:status', {
      codec: codecs.string,
      defaultValue: 'open',
      changeScope: ChangeScope.BlockDefault,
    })
    const taskType = defineBlockType({id: 'task', properties: [liftedSchema]})
    const runtime = resolveFacetRuntimeSync([
      typesFacet.of(taskType, {source: 'test'}),
    ])
    repo.setFacetRuntime(runtime)

    expect(repo.types.get('task')).toBe(taskType)
    expect(repo.propertySchemas.get('task:status')).toBe(liftedSchema)
  })

  it('direct property schema registrations override type-lifted conflicts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const liftedSchema = defineProperty<string>('status', {
        codec: codecs.string,
        defaultValue: 'open',
        changeScope: ChangeScope.BlockDefault,
      })
      const directSchema = defineProperty<string>('status', {
        codec: codecs.string,
        defaultValue: 'todo',
        changeScope: ChangeScope.BlockDefault,
      })
      const runtime = resolveFacetRuntimeSync([
        typesFacet.of(defineBlockType({id: 'task', properties: [liftedSchema]}), {source: 'test'}),
        propertySchemasFacet.of(directSchema, {source: 'test'}),
      ])
      repo.setFacetRuntime(runtime)

      expect(repo.propertySchemas.get('status')).toBe(directSchema)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('block-type kernel contribution lifts label, description, and properties props', () => {
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

  it('shared schema object lifted by multiple types dedups without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const sharedSchema = defineProperty<string>('status', {
        codec: codecs.string,
        defaultValue: 'open',
        changeScope: ChangeScope.BlockDefault,
      })
      const runtime = resolveFacetRuntimeSync([
        typesFacet.of(defineBlockType({id: 'todo', properties: [sharedSchema]}), {source: 'test'}),
        typesFacet.of(defineBlockType({id: 'task', properties: [sharedSchema]}), {source: 'test'}),
      ])
      repo.setFacetRuntime(runtime)

      expect(repo.propertySchemas.get('status')).toBe(sharedSchema)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('valuePresetsFacet', () => {
  it('keys presets by id and last-wins on collision', () => {
    const Editor = (): JSX.Element => createElement('span', null, null)
    const first = definePreset<string>({
      id: 'string',
      label: 'First',
      build: () => codecs.string,
      defaultValue: '',
      Editor,
    })
    const second = definePreset<string>({
      id: 'string',
      label: 'Second',
      build: () => codecs.string,
      defaultValue: '',
      Editor,
    })
    const runtime = resolveFacetRuntimeSync([
      valuePresetsFacet.of(first, {source: 'test'}),
      valuePresetsFacet.of(second, {source: 'test'}),
    ])
    expect(runtime.read(valuePresetsFacet).get('string')?.label).toBe('Second')
  })
})

describe('facet variance — typed plugin contributions register without widening', () => {
  // Reviewer P2: prior to AnyQuery / AnyPropertyEditorOverride / AnyPropertySchema,
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
    const typedUi = definePropertyEditorOverride<Date | undefined>({
      name: 'tasks:due-date',
      label: 'Due date',
      Editor: (): JSX.Element => createElement('span', null, null),
    })
    const runtime = resolveFacetRuntimeSync([
      propertyEditorOverridesFacet.of(typedUi, {source: 'plugin'}),
    ])
    const registered = runtime.read(propertyEditorOverridesFacet)
    expect(registered.get('tasks:due-date')).toBe(typedUi)
  })

  it('propertySchemasFacet accepts a typed PropertySchema<Date | undefined>', () => {
    const typedSchema = defineProperty<Date | undefined>('tasks:due-date', {
      codec: codecs.date,
      defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
    })
    const runtime = resolveFacetRuntimeSync([
      propertySchemasFacet.of(typedSchema, {source: 'plugin'}),
    ])
    const registered = runtime.read(propertySchemasFacet)
    expect(registered.get('tasks:due-date')).toBe(typedSchema)
  })
})

describe('Repo.onTypesChange', () => {
  // Symmetric to onPropertySchemasChange / onValuePresetsChange. Fires
  // when the rebuild step republishes the merged `_types` map — used by
  // user-types adoption flows (e.g. createTypeBlock's commit→
  // registration handoff) to bridge between txs without polling.

  it('fires when setRuntimeContributions publishes into the typesFacet user-data bucket', () => {
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    let calls = 0
    repo.onTypesChange(() => { calls++ })
    const userType = defineBlockType({id: 'user-defined-type-1'})
    repo.setRuntimeContributions(typesFacet, 'user-data', [userType])
    expect(calls).toBe(1)
    expect(repo.types.get('user-defined-type-1')).toBe(userType)
  })

  it('fires when setFacetRuntime swaps in a runtime with new type contributions', () => {
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    let calls = 0
    repo.onTypesChange(() => { calls++ })
    const extra = defineBlockType({id: 'extra-type'})
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      typesFacet.of(extra, {source: 'test'}),
    ]))
    expect(calls).toBeGreaterThan(0)
    expect(repo.types.get('extra-type')).toBe(extra)
  })

  it('disposer prevents subsequent notifications', () => {
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    let calls = 0
    const dispose = repo.onTypesChange(() => { calls++ })
    dispose()
    repo.setRuntimeContributions(typesFacet, 'user-data', [
      defineBlockType({id: 'a-type'}),
    ])
    expect(calls).toBe(0)
  })
})
