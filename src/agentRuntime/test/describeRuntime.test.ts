import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetApiSurfaceCacheForTest,
  describeFacets,
  describeRuntime,
  getApiSurface,
} from '@/agentRuntime/describeRuntime.ts'
import { defineFacet, resolveFacetRuntime } from '@/extensions/facet.ts'
// Pre-warm `@/extensions/api` so the dynamic import inside
// `getApiSurface()` resolves from cache. Under full-suite parallel
// loads, the cold transform of this barrel + its transitive deps can
// blow past the 5 s per-test timeout (file passes alone, fails ~10%
// of the time when 65+ other test files are competing for the parent
// Vite server's transform queue). Same `.ts` suffix as the dynamic
// import so both share a module-cache key.
import '@/extensions/api.ts'
import type { Repo } from '@/data/internals/repo'
import type { ActionConfig } from '@/shortcuts/types.ts'

beforeEach(() => {
  __resetApiSurfaceCacheForTest()
})

afterEach(() => {
  __resetApiSurfaceCacheForTest()
})

describe('describeFacets', () => {
  it('lists every facet that has at least one contribution', async () => {
    const a = defineFacet({id: 'desc.a'})
    const b = defineFacet({id: 'desc.b'})

    const runtime = await resolveFacetRuntime([
      a.of('alpha', {source: 'src-a'}),
      a.of('beta'),
      b.of('gamma', {source: 'src-b', precedence: 5}),
    ])

    const summary = describeFacets(runtime)
    expect(summary.map((f) => f.id).sort()).toEqual(['desc.a', 'desc.b'])

    const aSummary = summary.find((f) => f.id === 'desc.a')!
    expect(aSummary.contributionCount).toBe(2)
    expect(aSummary.contributions[0]?.source).toBe('src-a')
    expect(aSummary.contributions[1]?.source).toBeUndefined()

    const bSummary = summary.find((f) => f.id === 'desc.b')!
    expect(bSummary.contributions[0]?.source).toBe('src-b')
    expect(bSummary.contributions[0]?.precedence).toBe(5)
  })

  it('summarizes object-shaped contribution values by their interesting keys', async () => {
    const facet = defineFacet({id: 'desc.actions'})
    const runtime = await resolveFacetRuntime([
      facet.of({id: 'foo', description: 'Foo', context: 'global', handler: () => {}}),
    ])

    const [summary] = describeFacets(runtime)
    expect(summary.contributions[0]?.valueSummary).toContain('"id":"foo"')
    expect(summary.contributions[0]?.valueSummary).toContain('"description":"Foo"')
  })

  it('summarizes function values with name', async () => {
    const facet = defineFacet({id: 'desc.fn'})
    const runtime = await resolveFacetRuntime([
      facet.of(function namedFn() {}),
    ])

    const [summary] = describeFacets(runtime)
    expect(summary.contributions[0]?.valueSummary).toMatch(/^\[Function/)
    expect(summary.contributions[0]?.valueSummary).toContain('namedFn')
  })

  it('summarizes primitive values directly', async () => {
    const facet = defineFacet({id: 'desc.prim'})
    const runtime = await resolveFacetRuntime([
      facet.of(42),
      facet.of('hello'),
      facet.of(true),
    ])

    const [summary] = describeFacets(runtime)
    expect(summary.contributions.map((c) => c.valueSummary))
      .toEqual(['42', 'hello', 'true'])
  })
})

describe('getApiSurface', () => {
  it('returns the @/extensions/api module name and a non-empty exports list', async () => {
    const surface = await getApiSurface()
    expect(surface.module).toBe('@/extensions/api')
    expect(surface.exports.length).toBeGreaterThan(0)
    expect(surface.exports).toContain('defineFacet')
    expect(surface.exports).toContain('actionsFacet')
    expect(surface.exports).toContain('blockRenderersFacet')
  })

  it('memoizes — subsequent calls return the same array reference', async () => {
    const first = await getApiSurface()
    const second = await getApiSurface()
    expect(second).toBe(first)
  })
})

describe('describeRuntime', () => {
  const fakeRepo = {
    activeWorkspaceId: 'ws-1',
    user: {id: 'u-1', name: 'Test'},
  } as unknown as Repo

  const makeAction = (id: string, hasBinding: boolean): ActionConfig => ({
    id,
    description: `Description for ${id}`,
    context: 'global',
    handler: () => {},
    ...(hasBinding ? {defaultBinding: {keys: 'mod+x'}} : {}),
  })

  it('produces a payload with activeWorkspaceId, currentUser, safeMode, actions, renderers, facets, apiSurface', async () => {
    const facet = defineFacet({id: 'desc.full'})
    const runtime = await resolveFacetRuntime([
      facet.of('contribution', {source: 'src-1'}),
    ])

    const description = await describeRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: false,
      actions: [
        makeAction('a1', true),
        makeAction('a2', false),
      ],
      renderers: {default: () => null, custom: () => null},
    })

    expect(description.activeWorkspaceId).toBe('ws-1')
    expect(description.currentUser).toEqual({id: 'u-1', name: 'Test'})
    expect(description.safeMode).toBe(false)

    expect(description.actions).toEqual([
      {id: 'a1', description: 'Description for a1', context: 'global', hasDefaultBinding: true},
      {id: 'a2', description: 'Description for a2', context: 'global', hasDefaultBinding: false},
    ])

    expect(description.renderers.sort()).toEqual(['custom', 'default'])

    const facetIds = description.facets.map((f) => f.id)
    expect(facetIds).toContain('desc.full')

    expect(description.apiSurface.module).toBe('@/extensions/api')
    expect(description.apiSurface.exports).toContain('defineFacet')
  })

  it('reports safeMode=true when set', async () => {
    const runtime = await resolveFacetRuntime([])
    const description = await describeRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: true,
      actions: [],
      renderers: {},
    })
    expect(description.safeMode).toBe(true)
  })
})
