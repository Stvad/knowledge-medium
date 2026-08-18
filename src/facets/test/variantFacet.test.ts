import { describe, expect, it } from 'vitest'
import {
  defineVariantFacet,
  defineVariant,
  type VariantRegistration,
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
    const A: VariantRegistration<TestCtx, string> = defineVariant('a', 'A', 'render-a')
    const B: VariantRegistration<TestCtx, string> = defineVariant('b', 'B', 'render-b')

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
    const Always: VariantRegistration<TestCtx, string> = defineVariant('always', 'Always', 'r1')
    const TopLevelOnly: VariantRegistration<TestCtx, string> = {
      id: 'top',
      label: 'Top',
      resolve: ctx => ctx.isTopLevel ? {render: 'r2'} : null,
    }

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
      facet.of(defineVariant('flat', 'Flat', 'flat-r')),
      facet.of(defineVariant('grouped', 'Grouped', 'grouped-r')),
    ])

    const selection = runtime.read(facet)({isTopLevel: true})
    expect(selection.byId('flat')?.render).toBe('flat-r')
    expect(selection.byId('grouped')?.render).toBe('grouped-r')
    expect(selection.byId('missing')).toBeUndefined()
    expect(selection.byId(null)).toBeUndefined()
    expect(selection.byId(undefined)).toBeUndefined()
  })

  // The override idiom: an extension registers the id a built-in already
  // holds. `read` sorts by precedence BEFORE combining, so registration order
  // is gone by then — the survivor has to be chosen by precedence, and it has
  // to sit at the winner's slot, not at the loser's.
  describe('same-id registrations', () => {
    const facet = defineVariantFacet<TestCtx, string>({id: 'test.variant.override'})
    const host: VariantRegistration<TestCtx, string> = defineVariant('layout', 'Host', 'host-r')
    const other: VariantRegistration<TestCtx, string> = defineVariant('other', 'Other', 'other-r')

    const idsAndRenders = (...extensions: Parameters<typeof resolveFacetRuntimeSync>[0][]) => {
      const selection = resolveFacetRuntimeSync(extensions).read(facet)({isTopLevel: true})
      return {ids: selection.all.map(v => v.id), renders: selection.all.map(v => v.render)}
    }

    it('let the higher precedence win, whichever order they were registered in', () => {
      const override = defineVariant('layout', 'Override', 'override-r')
      expect(idsAndRenders(facet.of(host, {precedence: 20}), facet.of(override, {precedence: 30})).renders)
        .toEqual(['override-r'])
      expect(idsAndRenders(facet.of(override, {precedence: 30}), facet.of(host, {precedence: 20})).renders)
        .toEqual(['override-r'])
    })

    it('let the later registration win an equal precedence', () => {
      const override = defineVariant('layout', 'Override', 'override-r')
      expect(idsAndRenders(facet.of(host, {precedence: 20}), facet.of(override, {precedence: 20})).renders)
        .toEqual(['override-r'])
    })

    it('leave a lower-precedence namesake losing, as any other contribution would', () => {
      const weak = defineVariant('layout', 'Weak', 'weak-r')
      expect(idsAndRenders(facet.of(host, {precedence: 20}), facet.of(weak)).renders)
        .toEqual(['host-r'])
    })

    it('seat the survivor at the winning precedence, not the losing one', () => {
      const override = defineVariant('layout', 'Override', 'override-r')
      // 'other' sits between the two 'layout' registrations. The survivor
      // outranks it, so it must sort after it — seating the survivor at the
      // loser's slot would put it first and hand `last` to the wrong variant.
      const {ids} = idsAndRenders(
        facet.of(override, {precedence: 30}),
        facet.of(host, {precedence: 20}),
        facet.of(other, {precedence: 25}),
      )
      expect(ids).toEqual(['other', 'layout'])
    })
  })

  it('rejects invalid contributions via validate', () => {
    const facet = defineVariantFacet<TestCtx, string>({id: 'test.variant.validate'})
    // Smuggle an invalid contribution past TS so we exercise runtime validation.
    const invalid = facet.of('not-a-registration' as unknown as VariantRegistration<TestCtx, string>)
    const runtime = resolveFacetRuntimeSync([invalid])

    expect(runtime.read(facet)({isTopLevel: true}).all).toEqual([])
  })
})
