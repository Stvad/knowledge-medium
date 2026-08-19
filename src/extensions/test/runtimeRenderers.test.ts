import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { blockRendererFacet } from '@/extensions/blockInteraction.js'
import { readRuntimeRenderers } from '@/extensions/runtimeRenderers.js'
import type { BlockRenderer } from '@/types.js'

const Host: BlockRenderer = () => null
const Override: BlockRenderer = () => null

describe('readRuntimeRenderers', () => {
  it('keys installed registrations by id', () => {
    const runtime = resolveFacetRuntimeSync([
      blockRendererFacet.of({id: 'host', label: 'Host', render: Host}, {source: 'test'}),
    ])
    expect(readRuntimeRenderers(runtime).host?.render).toBe(Host)
  })

  // Contributions arrive in registration order here, but the live resolver
  // sees them sorted by precedence — so collapsing same-id registrations
  // without sorting first reports a renderer the UI does not use.
  it('reports the registration the resolver would pick, not the last registered', () => {
    const runtime = resolveFacetRuntimeSync([
      blockRendererFacet.of({id: 'x', label: 'Strong', render: Override}, {source: 'test', precedence: 20}),
      blockRendererFacet.of({id: 'x', label: 'Weak', render: Host}, {source: 'test'}),
    ])

    expect(readRuntimeRenderers(runtime).x?.render).toBe(Override)
    expect(runtime.read(blockRendererFacet)({} as never).byId('x')?.render).toBe(Override)
  })
})
