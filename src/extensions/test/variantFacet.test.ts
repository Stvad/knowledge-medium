import { describe, expect, it } from 'vitest'
import {
  defineVariantFacet,
  defineVariant,
  type VariantContribution,
} from '../variantFacet.ts'
import { resolveFacetRuntimeSync } from '../facet.ts'

interface TestCtx {
  isTopLevel: boolean
}

describe('defineVariantFacet', () => {
  it('returns an empty selection when no contributions are registered', () => {
    const facet = defineVariantFacet<TestCtx, string>({id: 'test.variant.empty'})
    const runtime = resolveFacetRuntimeSync([])

    const selection = runtime.read(facet)({isTopLevel: true})
    expect(selection.all).toEqual([])
    expect(selection.first).toBeUndefined()
    expect(selection.last).toBeUndefined()
    expect(selection.byId('anything')).toBeUndefined()
  })

  it('collects all returned variants in precedence order', () => {
    const facet = defineVariantFacet<TestCtx, string>({id: 'test.variant.collect'})
    const A: VariantContribution<TestCtx, string> = () => defineVariant('a', 'A', 'render-a')
    const B: VariantContribution<TestCtx, string> = () => defineVariant('b', 'B', 'render-b')

    const runtime = resolveFacetRuntimeSync([
      facet.of(A, {precedence: 1}),
      facet.of(B, {precedence: 2}),
    ])

    const selection = runtime.read(facet)({isTopLevel: true})
    expect(selection.all.map(v => v.id)).toEqual(['a', 'b'])
    expect(selection.first?.id).toBe('a')
    expect(selection.last?.id).toBe('b')
  })

  it('skips contributions returning null/undefined/false (gating)', () => {
    const facet = defineVariantFacet<TestCtx, string>({id: 'test.variant.gating'})
    const Always: VariantContribution<TestCtx, string> = () => defineVariant('always', 'Always', 'r1')
    const TopLevelOnly: VariantContribution<TestCtx, string> = ctx =>
      ctx.isTopLevel ? defineVariant('top', 'Top', 'r2') : null

    const runtime = resolveFacetRuntimeSync([
      facet.of(Always),
      facet.of(TopLevelOnly),
    ])

    const resolver = runtime.read(facet)
    expect(resolver({isTopLevel: false}).all.map(v => v.id)).toEqual(['always'])
    expect(resolver({isTopLevel: true}).all.map(v => v.id)).toEqual(['always', 'top'])
  })

  it('byId looks up a specific variant; returns undefined for missing ids', () => {
    const facet = defineVariantFacet<TestCtx, string>({id: 'test.variant.byid'})
    const runtime = resolveFacetRuntimeSync([
      facet.of(() => defineVariant('flat', 'Flat', 'flat-r')),
      facet.of(() => defineVariant('grouped', 'Grouped', 'grouped-r')),
    ])

    const selection = runtime.read(facet)({isTopLevel: true})
    expect(selection.byId('flat')?.render).toBe('flat-r')
    expect(selection.byId('grouped')?.render).toBe('grouped-r')
    expect(selection.byId('missing')).toBeUndefined()
    expect(selection.byId(null)).toBeUndefined()
    expect(selection.byId(undefined)).toBeUndefined()
  })

  it('rejects non-function contributions via validate', () => {
    const facet = defineVariantFacet<TestCtx, string>({id: 'test.variant.validate'})
    // Smuggle an invalid contribution past TS so we exercise runtime validation.
    const invalid = facet.of('not-a-function' as unknown as VariantContribution<TestCtx, string>)
    const runtime = resolveFacetRuntimeSync([invalid])

    expect(runtime.read(facet)({isTopLevel: true}).all).toEqual([])
  })
})
