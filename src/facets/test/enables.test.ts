/**
 * Typed-surface tests for `FacetContributionOptions.enables`.
 *
 * The resolver already recurses into `enables` via a structural check
 * (see resolveAppRuntime.test.ts > 'recurses into enables when the
 * parent contribution is accepted'). These tests assert the public
 * type-level surface: an author can declare `enables` on `facet.of(...)`
 * without a type assertion, and the runtime threads the contained
 * AppExtension through the boundary-aware resolver.
 *
 * If the field is missing from `FacetContributionOptions`, this file
 * fails to compile (which is the point — TDD on the type).
 */
import {describe, expect, it} from 'vitest'
import {defineFacet, type AppExtension} from '@/facets/facet.js'
import {resolveAppRuntimeSync} from '@/facets/resolveAppRuntime.js'
import {systemToggle, type Overrides} from '@/facets/togglable.js'

const emptyOverrides: Overrides = new Map()

describe('FacetContributionOptions.enables (typed surface)', () => {
  it('pulls along sibling contributions when the parent is accepted', () => {
    const parentFacet = defineFacet<number, number>({
      id: 'enables.parent',
      combine: vs => vs.reduce((a, b) => a + b, 0),
      empty: () => 0,
    })
    const labels = defineFacet<string, string>({
      id: 'enables.labels',
      combine: vs => vs.join(','),
      empty: () => '',
    })

    const enables: AppExtension = [labels.of('dragged-along')]
    const ext: AppExtension = parentFacet.of(1, {enables})

    const runtime = resolveAppRuntimeSync([ext], {overrides: emptyOverrides})

    expect(runtime.read(parentFacet)).toBe(1)
    expect(runtime.read(labels)).toBe('dragged-along')
  })

  it('honours the boundary filter on the parent contribution', () => {
    const parentFacet = defineFacet<number, number>({
      id: 'enables.bound-parent',
      combine: vs => vs.reduce((a, b) => a + b, 0),
      empty: () => 0,
    })
    const labels = defineFacet<string, string>({
      id: 'enables.bound-labels',
      combine: vs => vs.join(','),
      empty: () => '',
    })

    const handle = systemToggle({id: 'system:bound', name: 'Bound'})
    const enables: AppExtension = [labels.of('only-when-parent-survives')]

    // The parent contribution and its enables both sit inside the
    // togglable boundary. Disabling the boundary skips the parent
    // entirely, which means the resolver never sees the contribution
    // and therefore never recurses into enables.
    const runtime = resolveAppRuntimeSync(
      [handle.of(parentFacet.of(1, {enables}))],
      {overrides: new Map([['system:bound', false]])},
    )

    expect(runtime.read(parentFacet)).toBe(0)
    expect(runtime.read(labels)).toBe('')
  })

  it('drops enables when the parent contribution fails validation', () => {
    const parentFacet = defineFacet<number, number>({
      id: 'enables.validated-parent',
      combine: vs => vs.reduce((a, b) => a + b, 0),
      empty: () => 0,
      validate: (v): v is number => typeof v === 'number',
    })
    const labels = defineFacet<string, string>({
      id: 'enables.validated-labels',
      combine: vs => vs.join(','),
      empty: () => '',
    })

    const enables: AppExtension = [labels.of('orphaned')]
    // Construct an invalid parent through the typed surface: pass an
    // ill-typed value via the unknown escape hatch. The runtime's
    // validator drops it; the enables are not pulled in.
    const ext = parentFacet.of('not a number' as unknown as number, {enables})

    const runtime = resolveAppRuntimeSync([ext], {overrides: emptyOverrides})

    expect(runtime.read(parentFacet)).toBe(0)
    expect(runtime.read(labels)).toBe('')
  })

  it('chains: enables can themselves carry enables', () => {
    const a = defineFacet<string, string>({
      id: 'enables.chain-a',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const b = defineFacet<string, string>({
      id: 'enables.chain-b',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const c = defineFacet<string, string>({
      id: 'enables.chain-c',
      combine: vs => vs.join(','),
      empty: () => '',
    })

    const ext: AppExtension = a.of('a-value', {
      enables: b.of('b-value', {
        enables: c.of('c-value'),
      }),
    })

    const runtime = resolveAppRuntimeSync([ext], {overrides: emptyOverrides})

    expect(runtime.read(a)).toBe('a-value')
    expect(runtime.read(b)).toBe('b-value')
    expect(runtime.read(c)).toBe('c-value')
  })
})
