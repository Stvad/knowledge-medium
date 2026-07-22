// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  resolveSpatialNavExclusions,
  spatialNavExclusionsFacet,
} from '../exclusionsFacet.ts'
import { DEFAULT_NON_NAVIGABLE_SURFACES, panelInstances } from '../walker.ts'
import { spatialNavigationPlugin } from '../index.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('spatialNavExclusionsFacet', () => {
  it('combines contributions from multiple sources into a Set', () => {
    const runtime = resolveFacetRuntimeSync([
      spatialNavExclusionsFacet.of('breadcrumb', {source: 'spatial-navigation'}),
      spatialNavExclusionsFacet.of('kanban-cell', {source: 'test-kanban-plugin'}),
    ])
    expect(runtime.read(spatialNavExclusionsFacet)).toEqual(new Set(['breadcrumb', 'kanban-cell']))
  })

  it("core's own plugin extension contributes exactly 'breadcrumb' — unchanged default", () => {
    const runtime = resolveFacetRuntimeSync(spatialNavigationPlugin)
    expect(runtime.read(spatialNavExclusionsFacet)).toEqual(new Set(['breadcrumb']))
  })
})

describe('resolveSpatialNavExclusions', () => {
  it('falls back to the walker default when there is no facet runtime', () => {
    expect(resolveSpatialNavExclusions(null)).toBe(DEFAULT_NON_NAVIGABLE_SURFACES)
  })

  it('reads the live facet-resolved set when a runtime is present', () => {
    const runtime = resolveFacetRuntimeSync(
      spatialNavExclusionsFacet.of('kanban-cell', {source: 'test-kanban-plugin'}),
    )
    // No 'breadcrumb' contribution in this runtime (core's own extension
    // wasn't included) — only what was actually contributed comes back.
    expect(resolveSpatialNavExclusions(runtime)).toEqual(new Set(['kanban-cell']))
  })
})

// End-to-end: a contributed surface name is excluded by the walker exactly
// the same way 'breadcrumb' is — this is the actual seam a grid/kanban/canvas
// extension would use to exempt its own `data-block-surface` cells from the
// arrow-key walker (see `walker.ts`'s tagging contract).
describe('walker + contributed exclusions', () => {
  const buildPanel = (): HTMLElement => {
    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', 'p1')
    for (const {blockId, surface} of [
      {blockId: 'A', surface: 'outline'},
      {blockId: 'crumb', surface: 'breadcrumb'},
      {blockId: 'cell', surface: 'kanban-cell'},
    ]) {
      const el = document.createElement('div')
      el.setAttribute('data-block-nav-item', 'true')
      el.setAttribute('data-block-id', blockId)
      el.setAttribute('data-render-scope-id', `p1:${blockId}`)
      el.setAttribute('data-block-surface', surface)
      panel.appendChild(el)
    }
    document.body.appendChild(panel)
    return panel
  }

  it('skips a contributed surface exactly as it skips breadcrumb', () => {
    const panel = buildPanel()
    const runtime = resolveFacetRuntimeSync([
      spatialNavExclusionsFacet.of('breadcrumb', {source: 'spatial-navigation'}),
      spatialNavExclusionsFacet.of('kanban-cell', {source: 'test-kanban-plugin'}),
    ])
    const excludedSurfaces = resolveSpatialNavExclusions(runtime)

    const scopes = panelInstances(panel, excludedSurfaces).map(el => el.dataset.renderScopeId)
    expect(scopes).toEqual(['p1:A'])
  })

  it('breadcrumb is excluded by default even with no extra contributions', () => {
    const panel = buildPanel()
    const runtime = resolveFacetRuntimeSync(
      spatialNavExclusionsFacet.of('breadcrumb', {source: 'spatial-navigation'}),
    )
    const excludedSurfaces = resolveSpatialNavExclusions(runtime)

    // breadcrumb still skipped, but the un-contributed 'kanban-cell' surface
    // is navigable — the seam is opt-in per contribution, not a hardcoded pair.
    const scopes = panelInstances(panel, excludedSurfaces).map(el => el.dataset.renderScopeId)
    expect(scopes).toEqual(['p1:A', 'p1:cell'])
  })
})
