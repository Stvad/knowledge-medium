import { describe, expect, it } from 'vitest'
import * as km from '@/extensions/api'

// The api module is a curated re-export surface for extension authors.
// This smoke test catches accidental drops in named exports (renames,
// missing re-exports) without locking the entire surface against
// intentional change.
describe('@/extensions/api — public surface', () => {
  // List of names extension authors are encouraged to rely on. If a
  // name moves, update both the api.ts re-export and this list (the
  // breakage of which becomes the audit trail for callers).
  const requiredExports = [
    // Facet primitives
    'defineFacet',
    // Blessed core facets
    'actionsFacet',
    'actionContextsFacet',
    'blockRenderersFacet',
    // Block-interaction facets
    'blockClickHandlersFacet',
    'blockContentDecoratorsFacet',
    'blockContentRendererFacet',
    'blockContentSurfacePropsFacet',
    'shortcutSurfaceActivationsFacet',
    'enterBlockEditMode',
    'focusBlock',
    'getBlockContentRendererSlot',
    // Markdown
    'markdownExtensionsFacet',
    // Actions
    'ActionContextTypes',
    'bindBlockActionContext',
    'createSharedBlockActions',
    // Block / data primitives
    'Block',
    'Repo',
    'getActivePanelBlock',
    'boolProp',
    'numberProperty',
    'stringProperty',
    'extensionDisabledProp',
    'uiChangeScope',
  ]

  for (const name of requiredExports) {
    it(`exports ${name}`, () => {
      expect(km).toHaveProperty(name)
      expect((km as Record<string, unknown>)[name]).toBeDefined()
    })
  }

  it('defineFacet returns something callable', () => {
    const facet = km.defineFacet({id: 'test.api-smoke'})
    expect(typeof facet.of).toBe('function')
    expect(facet.id).toBe('test.api-smoke')
  })
})
