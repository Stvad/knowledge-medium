// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { pluginDataExtensions } from '@/data/pluginDataExtensions.js'
import { propertyEditorOverridesFacet } from '@/data/facets.js'
import {
  actionsFacet,
  appMountsFacet,
  blockRenderersFacet,
  headerItemsFacet,
} from '@/extensions/core.js'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'

// The data-only / graph-free invariant for `plugins/<name>/dataExtension.ts`:
// these modules feed the headless data layer (the local-schema DDL applied
// before the React tree mounts, and a future Node-only data runtime) and are
// imported by the node-env `createTestDb` glob, so they must NOT contribute UI
// surfaces or pull the React/CodeMirror graph. The createTestDb eval-safety
// test catches DOM access at module-eval (a throw); this catches the subtler
// leak — a stray action / editor / renderer contribution — which a React
// import almost always drags in but which would otherwise import fine under
// Node and pass every other test.
describe('pluginDataExtensions (data-only invariant)', () => {
  it('discovers at least one plugin data extension', () => {
    expect(pluginDataExtensions.length).toBeGreaterThan(0)
  })

  it('contributes no UI facets', () => {
    const contributed = new Set(resolveFacetRuntimeSync(pluginDataExtensions).facetIds())
    const uiFacets = [
      actionsFacet,
      blockRenderersFacet,
      appMountsFacet,
      headerItemsFacet,
      codeMirrorExtensionsFacet,
      markdownExtensionsFacet,
      propertyEditorOverridesFacet,
    ]
    const leaked = uiFacets.map(facet => facet.id).filter(id => contributed.has(id))
    expect(leaked).toEqual([])
  })
})
