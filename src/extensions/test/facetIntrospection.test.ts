import { describe, expect, it } from 'vitest'
import { defineFacet, resolveFacetRuntime } from '@/extensions/facet'

describe('FacetRuntime introspection', () => {
  it('facetIds() returns every id with at least one contribution', async () => {
    const a = defineFacet({id: 'introspect.a'})
    const b = defineFacet({id: 'introspect.b'})

    const runtime = await resolveFacetRuntime([
      a.of('x'),
      b.of('y'),
      a.of('z'),
    ])

    expect(runtime.facetIds().sort()).toEqual(['introspect.a', 'introspect.b'])
  })

  it('facetIds() omits facets without contributions', async () => {
    const runtime = await resolveFacetRuntime([])
    expect(runtime.facetIds()).toEqual([])
  })

  it('contributionsById matches contributions(facet)', async () => {
    const facet = defineFacet({id: 'introspect.match'})
    const runtime = await resolveFacetRuntime([
      facet.of('first', {source: 'src-1'}),
      facet.of('second', {source: 'src-2', precedence: 5}),
    ])

    const byObject = runtime.contributions(facet)
    const byId = runtime.contributionsById('introspect.match')
    expect(byId).toEqual(byObject)
    expect(byId.length).toBe(2)
    expect(byId[0]?.source).toBe('src-1')
    expect(byId[1]?.precedence).toBe(5)
  })

  it('contributionsById returns empty for unknown ids', async () => {
    const runtime = await resolveFacetRuntime([])
    expect(runtime.contributionsById('nope')).toEqual([])
  })
})
