import { describe, expect, it } from 'vitest'
import { defineBlockType, seedType } from '@/data/api'
import { typeSeedsFacet, typesFacet } from '@/data/facets.js'
import { appEffectsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { pluginPrefsExtension, pluginUIStateExtension } from './pluginStateExtensions.js'

// Guards `hiddenPluginTypeContribution`'s provenance routing: a `seedType`
// materializes (→ typeSeedsFacet), while a plain `TypeContribution` (a bare
// `defineBlockType` — e.g. a dynamic extension that hasn't adopted
// `extensionTypeSeedKey`) falls back to the static `typesFacet`. That fallback
// branch is unused by the in-app static plugins (all now seedType), so without
// this test a flipped ternary or a changed `isTypeSeedDeclaration` would go
// uncaught.
describe('pluginStateExtensions routing', () => {
  it('routes a seedType container through typeSeedsFacet, forced hidden from completion', () => {
    const type = seedType({seedKey: 'system:test/type/test-prefs', revision: 1, id: 'test-prefs', label: 'Test prefs'})
    const runtime = resolveFacetRuntimeSync(pluginPrefsExtension(type, 'test'))

    // The seed lands in typeSeedsFacet with its provenance intact and
    // hideFromCompletion forced true (the caller's seedType didn't set it).
    expect(runtime.read(typeSeedsFacet).find(t => t.id === 'test-prefs')).toMatchObject({
      id: 'test-prefs',
      seedKey: 'system:test/type/test-prefs',
      revision: 1,
      hideFromCompletion: true,
    })
    // ...and NOT into the static typesFacet (a leak would double-contribute).
    expect(runtime.read(typesFacet).has('test-prefs')).toBe(false)
    // The idle eager-bootstrap effect is bundled alongside.
    expect(runtime.read(appEffectsFacet).some(e => e.id === 'plugin-prefs.test-prefs.bootstrap')).toBe(true)
  })

  it('routes a plain (dynamic-extension) container through typesFacet, forced hidden from completion', () => {
    const type = defineBlockType({id: 'dyn-prefs', label: 'Dyn prefs'})
    const runtime = resolveFacetRuntimeSync(pluginPrefsExtension(type, 'test'))

    expect(runtime.read(typesFacet).get('dyn-prefs')).toMatchObject({id: 'dyn-prefs', hideFromCompletion: true})
    // A plain type carries no seedKey → nothing seeded.
    expect(runtime.read(typeSeedsFacet)).toHaveLength(0)
  })

  it('pluginUIStateExtension shares the routing and bundles its own bootstrap effect', () => {
    const type = seedType({seedKey: 'system:test/type/test-ui-state', revision: 1, id: 'test-ui-state', label: 'Test ui-state'})
    const runtime = resolveFacetRuntimeSync(pluginUIStateExtension(type, 'test'))

    expect(runtime.read(typeSeedsFacet).some(t => t.id === 'test-ui-state')).toBe(true)
    expect(runtime.read(appEffectsFacet).some(e => e.id === 'plugin-ui-state.test-ui-state.bootstrap')).toBe(true)
  })
})
