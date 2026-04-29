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
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope, defineMutator, MutatorNotRegisteredError } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { mutatorsFacet } from './facets'
import { Repo } from './repo'

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
    registerKernel: false,  // start empty so setFacetRuntime is the only registration
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
    // We started with registerKernel: false, so the registry begins empty.
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
