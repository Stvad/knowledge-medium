import { describe, expect, it } from 'vitest'
import { seedType } from '@/data/api'
import { typeSeedsFacet } from '@/data/facets.js'
import { appEffectsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { pluginPrefsExtension, pluginUIStateExtension } from './pluginStateExtensions.js'

// Guards `hiddenPluginTypeContribution`'s provenance routing: a `seedType`
// materializes into `typeSeedsFacet`, carrying its provenance
// (seedKey/revision) through with `hideFromCompletion` forced true. The
// schema-unification migration removed the transitional `typesFacet`
// fallback for a plain (non-seed) `TypeContribution` — every caller,
// static or dynamic, now supplies a `seedType` (dynamic extensions via
// `extensionTypeSeedKey`) — so `pluginPrefsExtension`/`pluginUIStateExtension`
// only accept `TypeSeedDeclaration` and there is no plain-container branch
// left to test.
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
    // The idle eager-bootstrap effect is bundled alongside.
    expect(runtime.read(appEffectsFacet).some(e => e.id === 'plugin-prefs.test-prefs.bootstrap')).toBe(true)
  })

  it('pluginUIStateExtension shares the routing and bundles its own bootstrap effect', () => {
    const type = seedType({seedKey: 'system:test/type/test-ui-state', revision: 1, id: 'test-ui-state', label: 'Test ui-state'})
    const runtime = resolveFacetRuntimeSync(pluginUIStateExtension(type, 'test'))

    expect(runtime.read(typeSeedsFacet).some(t => t.id === 'test-ui-state')).toBe(true)
    expect(runtime.read(appEffectsFacet).some(e => e.id === 'plugin-ui-state.test-ui-state.bootstrap')).toBe(true)
  })
})
