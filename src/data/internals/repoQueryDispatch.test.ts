// @vitest-environment node
/**
 * Phase 4 chunk A — `repo.query` dispatcher contract.
 *
 * Exercises the typed dispatch + handle-store integration without any
 * kernel queries registered (those land in chunk B). Tests pin the
 * surface that chunk B + C build on top of:
 *
 *   - dispatcher resolution: literal name, `core.<bare>` shortcut,
 *     `QueryNotRegisteredError` for unknown names
 *   - argsSchema validation rejects malformed args at the boundary
 *   - identity stability: two `repo.query.X(args)` calls return the
 *     same `LoaderHandle` (handle-store keyed by `(name, args)`)
 *   - distinct args / distinct names produce distinct handles
 *   - `repo.runQuery(name, args)` delegates to the same dispatch path
 *     and resolves to the loader's value
 *   - `setFacetRuntime` swap replaces the query registry
 *   - empty-args queries dispatch + identity-stabilize correctly
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import {
  defineQuery,
  QueryNotRegisteredError,
  type Query,
} from '@/data/api'
import type { Dependency as Dep } from './handleStore'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { queriesFacet } from './facets'
import { Repo } from './repo'

let h: TestDb
let cache: BlockCache
let repo: Repo
beforeEach(async () => {
  h = await createTestDb()
  cache = new BlockCache()
  repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    // Empty registries — chunk A test surface is the dispatcher itself,
    // not any registered query. Kernel mutators / processors stay off
    // for the same reason.
    registerKernelMutators: false,
    registerKernelProcessors: false,
    registerKernelQueries: false,
  })
})
afterEach(async () => { await h.cleanup() })

const makeEchoQuery = (name: string): Query<{value: string}, string> =>
  defineQuery<{value: string}, string>({
    name,
    argsSchema: z.object({value: z.string()}),
    resultSchema: z.string(),
    resolve: async ({value}, ctx) => {
      ctx.depend({kind: 'table', table: 'blocks'})
      return value
    },
  })

describe('repo.query dispatcher resolution', () => {
  it('throws QueryNotRegisteredError for an unknown name (literal + core.<bare> both miss)', () => {
    expect(() => repo.query['plugin:nope']({})).toThrow(QueryNotRegisteredError)
    expect(() => repo.query.notARealName({})).toThrow(QueryNotRegisteredError)
  })

  it('resolves a literal full name', async () => {
    repo.__setQueriesForTesting([makeEchoQuery('plugin:echo')])
    const handle = repo.query['plugin:echo']({value: 'hi'})
    await expect(handle.load()).resolves.toBe('hi')
  })

  it('resolves a bare name to its core.<bare> registry entry', async () => {
    repo.__setQueriesForTesting([makeEchoQuery('core.echo')])
    // bare access works
    const handleBare = repo.query.echo({value: 'world'})
    // and the literal full name reaches the same slot
    const handleFull = repo.query['core.echo']({value: 'world'})
    expect(handleBare).toBe(handleFull)
    await expect(handleBare.load()).resolves.toBe('world')
  })

  it('prefers literal over core.<bare> when both could match', async () => {
    // Both `'foo'` and `'core.foo'` registered — bare access goes to
    // the literal slot. Echoes return distinct strings to disambiguate.
    const literalFoo = defineQuery<Record<string, never>, string>({
      name: 'foo',
      argsSchema: z.object({}),
      resultSchema: z.string(),
      resolve: async (_args, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return 'literal'
      },
    })
    const coreFoo = defineQuery<Record<string, never>, string>({
      name: 'core.foo',
      argsSchema: z.object({}),
      resultSchema: z.string(),
      resolve: async (_args, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return 'core'
      },
    })
    repo.__setQueriesForTesting([literalFoo, coreFoo])
    await expect(repo.query.foo({}).load()).resolves.toBe('literal')
    await expect(repo.query['core.foo']({}).load()).resolves.toBe('core')
  })
})

describe('argsSchema validation at dispatch boundary', () => {
  it('throws synchronously when args fail the schema', () => {
    repo.__setQueriesForTesting([makeEchoQuery('plugin:echo')])
    // Missing `value` (required string) — zod throws ZodError synchronously
    // from `argsSchema.parse(args)` before any handle is allocated.
    expect(() => repo.query['plugin:echo']({})).toThrow()
    // Wrong type also rejected.
    expect(() => repo.query['plugin:echo']({value: 42})).toThrow()
  })

  it('passes the parsed args through to resolve', async () => {
    let observedArgs: unknown
    const q = defineQuery<{n: number}, number>({
      name: 'plugin:double',
      argsSchema: z.object({n: z.number()}),
      resultSchema: z.number(),
      resolve: async (args, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        observedArgs = args
        return args.n * 2
      },
    })
    repo.__setQueriesForTesting([q])
    await expect(repo.query['plugin:double']({n: 21}).load()).resolves.toBe(42)
    expect(observedArgs).toEqual({n: 21})
  })
})

describe('identity stability', () => {
  it('two calls with the same args return the same LoaderHandle', () => {
    repo.__setQueriesForTesting([makeEchoQuery('plugin:echo')])
    const a = repo.query['plugin:echo']({value: 'x'})
    const b = repo.query['plugin:echo']({value: 'x'})
    expect(a).toBe(b)
  })

  it('different args produce different handles', () => {
    repo.__setQueriesForTesting([makeEchoQuery('plugin:echo')])
    const a = repo.query['plugin:echo']({value: 'x'})
    const b = repo.query['plugin:echo']({value: 'y'})
    expect(a).not.toBe(b)
  })

  it('different query names produce different handles', () => {
    repo.__setQueriesForTesting([
      makeEchoQuery('plugin:a'),
      makeEchoQuery('plugin:b'),
    ])
    const a = repo.query['plugin:a']({value: 'x'})
    const b = repo.query['plugin:b']({value: 'x'})
    expect(a).not.toBe(b)
  })

  it('args with the same shape but different key order share a handle', () => {
    // `stableArgsKey` sorts object keys before serializing — `{a:1,b:2}`
    // and `{b:2,a:1}` must hit the same slot per the spec identity rule.
    const q = defineQuery<{a: number; b: number}, number>({
      name: 'plugin:sum',
      argsSchema: z.object({a: z.number(), b: z.number()}),
      resultSchema: z.number(),
      resolve: async ({a, b}, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return a + b
      },
    })
    repo.__setQueriesForTesting([q])
    const h1 = repo.query['plugin:sum']({a: 1, b: 2})
    const h2 = repo.query['plugin:sum']({b: 2, a: 1})
    expect(h1).toBe(h2)
  })
})

describe('repo.runQuery dynamic dispatch', () => {
  it('resolves through the same path and returns the loader value', async () => {
    repo.__setQueriesForTesting([makeEchoQuery('plugin:echo')])
    const out = await repo.runQuery<string>('plugin:echo', {value: 'dyn'})
    expect(out).toBe('dyn')
  })

  it('rejects an unknown name with QueryNotRegisteredError', async () => {
    await expect(repo.runQuery('plugin:nope', {})).rejects.toThrow(QueryNotRegisteredError)
  })

  it('rejects bad args via the argsSchema', async () => {
    repo.__setQueriesForTesting([makeEchoQuery('plugin:echo')])
    await expect(repo.runQuery('plugin:echo', {})).rejects.toThrow()
  })

  it('honors the core.<bare> shortcut', async () => {
    repo.__setQueriesForTesting([makeEchoQuery('core.echo')])
    await expect(repo.runQuery<string>('echo', {value: 'shortcut'}))
      .resolves.toBe('shortcut')
  })
})

describe('setFacetRuntime swap invalidates cached query handles (P2 #1)', () => {
  it('a same-name swap dispatches through the new resolver, not the old one', async () => {
    // V1 of the plugin query.
    const v1 = defineQuery<{x: number}, string>({
      name: 'plugin:swap',
      argsSchema: z.object({x: z.number()}),
      resultSchema: z.string(),
      resolve: async ({x}, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return `v1:${x}`
      },
    })
    repo.__setQueriesForTesting([v1])
    const handleV1 = repo.query['plugin:swap']({x: 1})
    await expect(handleV1.load()).resolves.toBe('v1:1')

    // V2 — different instance, different resolver string.
    const v2 = defineQuery<{x: number}, string>({
      name: 'plugin:swap',
      argsSchema: z.object({x: z.number()}),
      resultSchema: z.string(),
      resolve: async ({x}, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return `v2:${x}`
      },
    })
    repo.__setQueriesForTesting([v2])

    // Same args — should resolve via v2, NOT v1's cached handle.
    const handleV2 = repo.query['plugin:swap']({x: 1})
    expect(handleV2).not.toBe(handleV1)
    await expect(handleV2.load()).resolves.toBe('v2:1')
  })

  it('an unchanged kernel query keeps its handle identity across swaps', () => {
    // Same Query instance through both setFacetRuntime calls — generation
    // does NOT bump; handle identity preserved.
    const stable = makeEchoQuery('plugin:stable')
    repo.__setQueriesForTesting([stable])
    const before = repo.query['plugin:stable']({value: 'k'})
    repo.__setQueriesForTesting([stable])
    const after = repo.query['plugin:stable']({value: 'k'})
    expect(after).toBe(before)
  })

  it('a query removed and re-added with a new instance dispatches via the new instance', async () => {
    const v1 = defineQuery<{x: number}, string>({
      name: 'plugin:gone',
      argsSchema: z.object({x: z.number()}),
      resultSchema: z.string(),
      resolve: async ({x}, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return `gone-v1:${x}`
      },
    })
    repo.__setQueriesForTesting([v1])
    await expect(repo.query['plugin:gone']({x: 5}).load()).resolves.toBe('gone-v1:5')

    // Remove it.
    repo.__setQueriesForTesting([])
    expect(() => repo.query['plugin:gone']({x: 5})).toThrow(QueryNotRegisteredError)

    // Re-add with a fresh instance.
    const v2 = defineQuery<{x: number}, string>({
      name: 'plugin:gone',
      argsSchema: z.object({x: z.number()}),
      resultSchema: z.string(),
      resolve: async ({x}, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return `gone-v2:${x}`
      },
    })
    repo.__setQueriesForTesting([v2])
    await expect(repo.query['plugin:gone']({x: 5}).load()).resolves.toBe('gone-v2:5')
  })
})

describe('setFacetRuntime swaps the query registry', () => {
  it('replaces queries so previously-resolvable names become QueryNotRegisteredError', () => {
    const q = makeEchoQuery('plugin:echo')
    // Wire it through the runtime path (not __setQueriesForTesting).
    const runtime = resolveFacetRuntimeSync([
      queriesFacet.of(q, {source: 'plugin'}),
    ])
    repo.setFacetRuntime(runtime)
    expect(() => repo.query['plugin:echo']({value: 'x'})).not.toThrow()

    // Empty runtime — replaces with no queries.
    const emptyRuntime = resolveFacetRuntimeSync([])
    repo.setFacetRuntime(emptyRuntime)
    expect(() => repo.query['plugin:echo']({value: 'x'})).toThrow(QueryNotRegisteredError)
  })

  it('a runtime-registered query dispatches end-to-end through repo.query', async () => {
    const q = makeEchoQuery('plugin:fromRuntime')
    const runtime = resolveFacetRuntimeSync([
      queriesFacet.of(q, {source: 'plugin'}),
    ])
    repo.setFacetRuntime(runtime)
    const handle = repo.query['plugin:fromRuntime']({value: 'rt'})
    await expect(handle.load()).resolves.toBe('rt')
  })
})

describe('explicit ctx.depend({kind:"table"}) registers a table dep', () => {
  // Coarse table deps must come from the resolver's explicit
  // ctx.depend call — there is no auto-declare from any Query field.
  // This pins the contract: the only way a query gets a table dep is
  // by asking for one. Plugin queries that need one (typically the
  // table-scan with-empty-result case) call ctx.depend directly.
  it('a resolver calling ctx.depend({kind:"table"}) gets that dep', async () => {
    const explicitTable = defineQuery<Record<string, never>, number>({
      name: 'plugin:explicitTable',
      argsSchema: z.object({}),
      resultSchema: z.number(),
      resolve: async (_args, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return 1
      },
    })
    repo.__setQueriesForTesting([explicitTable])
    const handle = repo.query['plugin:explicitTable']({})
    await handle.load()
    const deps = (handle as unknown as {__depsForTest(): readonly Dep[]}).__depsForTest()
    expect(deps).toEqual([{kind: 'table', table: 'blocks'}])
  })
})

describe('resultSchema validation at the boundary', () => {
  it('parses the resolver result through resultSchema before publishing', async () => {
    // Plugin returns a value the schema accepts — pass-through.
    const okQuery = defineQuery<{n: number}, number>({
      name: 'plugin:okSchema',
      argsSchema: z.object({n: z.number()}),
      resultSchema: z.number(),
      resolve: async ({n}, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return n
      },
    })
    repo.__setQueriesForTesting([okQuery])
    await expect(repo.query['plugin:okSchema']({n: 7}).load()).resolves.toBe(7)
  })

  it('rejects when the resolver returns a value that violates resultSchema', async () => {
    // Schema demands a number; resolver lies and returns a string. The
    // dispatcher's resultSchema.parse boundary is the safety net for
    // dynamic plugins where TS can't catch this.
    const badQuery = defineQuery<Record<string, never>, number>({
      name: 'plugin:badSchema',
      argsSchema: z.object({}),
      // Strict: number expected.
      resultSchema: z.number(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: async (_args, ctx): Promise<any> => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return 'not a number'
      },
    })
    repo.__setQueriesForTesting([badQuery])
    await expect(repo.query['plugin:badSchema']({}).load()).rejects.toThrow()
  })
})

describe('empty-args queries', () => {
  it('dispatch + identity-stabilize when argsSchema is z.object({})', () => {
    const q = defineQuery<Record<string, never>, string>({
      name: 'plugin:noargs',
      argsSchema: z.object({}),
      resultSchema: z.string(),
      resolve: async (_args, ctx) => {
        ctx.depend({kind: 'table', table: 'blocks'})
        return 'ok'
      },
    })
    repo.__setQueriesForTesting([q])
    const a = repo.query['plugin:noargs']({})
    const b = repo.query['plugin:noargs']({})
    expect(a).toBe(b)
  })
})
