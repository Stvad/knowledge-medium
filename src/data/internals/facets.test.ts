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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createElement, type JSX } from 'react'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import {
  ChangeScope,
  codecs,
  defineMutator,
  defineProperty,
  definePropertyUi,
  defineQuery,
  MutatorNotRegisteredError,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '../kernelDataExtension'
import { mutatorsFacet, propertySchemasFacet, propertyUiFacet, queriesFacet } from '../facets'
import { KERNEL_PROPERTY_SCHEMAS } from '@/data/properties'
import { Repo } from '../repo'

let h: TestDb
let cache: BlockCache
let repo: Repo
beforeEach(async () => {
  h = await createTestDb()
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
afterEach(async () => { await h.cleanup() })

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
      codec: codecs.optional(codecs.string),
      defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
      kind: 'string',
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
        codec: codecs.optional(codecs.string),
        defaultValue: undefined,
        changeScope: ChangeScope.BlockDefault,
        kind: 'string',
      })
      const b = defineProperty<string | undefined>('plugin:dup', {
        codec: codecs.optional(codecs.string),
        defaultValue: undefined,
        changeScope: ChangeScope.BlockDefault,
        kind: 'string',
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

describe('facet variance — typed plugin contributions register without widening', () => {
  // Reviewer P2: prior to AnyQuery / AnyPropertyUiContribution / AnyPropertySchema,
  // typed plugin contributions failed to register because the facet's
  // contribution type (`Query<unknown, unknown>` / `PropertyUiContribution<unknown>`
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

  it('propertyUiFacet accepts a typed PropertyUiContribution<Date | undefined>', () => {
    const typedUi = definePropertyUi<Date | undefined>({
      name: 'tasks:due-date',
      label: 'Due date',
      Editor: (): JSX.Element => createElement('span', null, null),
    })
    const runtime = resolveFacetRuntimeSync([
      propertyUiFacet.of(typedUi, {source: 'plugin'}),
    ])
    const registered = runtime.read(propertyUiFacet)
    expect(registered.get('tasks:due-date')).toBe(typedUi)
  })

  it('propertySchemasFacet accepts a typed PropertySchema<Date | undefined>', () => {
    const typedSchema = defineProperty<Date | undefined>('tasks:due-date', {
      codec: codecs.optional(codecs.date),
      defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
      kind: 'date',
    })
    const runtime = resolveFacetRuntimeSync([
      propertySchemasFacet.of(typedSchema, {source: 'plugin'}),
    ])
    const registered = runtime.read(propertySchemasFacet)
    expect(registered.get('tasks:due-date')).toBe(typedSchema)
  })
})
