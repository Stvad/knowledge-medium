import { blockTypeRendererRegistration } from '@/components/renderer/BlockTypeBlockRenderer.js'
import { codeMirrorExtensionRendererRegistration } from '@/components/renderer/CodeMirrorExtensionBlockRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { layoutRendererRegistration } from '@/components/renderer/LayoutRenderer.js'
import { missingDataRendererRegistration } from '@/components/renderer/MissingDataRenderer.js'
import { panelRendererRegistration } from '@/components/renderer/PanelRenderer.js'
import { propertySchemaRendererRegistration } from '@/components/renderer/PropertySchemaBlockRenderer.js'
import { topLevelRendererRegistration } from '@/components/renderer/TopLevelRenderer.js'
import { blockRendererFacet, type BlockRendererRegistration } from '@/extensions/blockInteraction.js'
import { systemToggle } from '@/facets/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.js'

/**
 * Core's renderer ladder, weakest first. Precedence is the ranking — the
 * last registration that claims a block wins — so the numbers are the
 * whole story and are kept here rather than beside each component, where
 * you could not see what a renderer outranks.
 *
 * The plain block renderer sits at the implicit 0 and claims
 * unconditionally; everything above it self-gates. Plugins slot into the
 * same scale (breadcrumbs 10, media 5, the SRS deck and the recents page
 * 100), so a plugin renderer and a core one are ordered by one number
 * rather than by which layer registered them.
 *
 * An equal precedence is decided by registration order, so two renderers
 * that can claim the SAME block need distinct numbers or the winner is
 * whatever the extension graph happens to visit last. That is why the two
 * type editors differ by one: a block may legally carry both
 * `property-schema` and `block-type`, and the schema editor is the one
 * that has always won it.
 */
export const coreRendererLadder: readonly (readonly [BlockRendererRegistration, number])[] = [
  [{id: 'default', label: 'Block', render: DefaultBlockRenderer}, 0],
  [missingDataRendererRegistration, 1],
  [codeMirrorExtensionRendererRegistration, 5],
  [panelRendererRegistration, 5],
  [topLevelRendererRegistration, 20],
  [layoutRendererRegistration, 20],
  [blockTypeRendererRegistration, 100],
  [propertySchemaRendererRegistration, 101],
]

export const defaultRenderersExtension = systemToggle({
  id: 'system:default-renderers',
  name: 'Default renderers',
  description: 'Block renderer registry and the fallback renderer used when no plugin claims a block.',
  essential: true,
}).of([
  markdownExtensionsFacet.of(gfmMarkdownExtension, {source: 'defaultRenderers'}),
  ...coreRendererLadder.map(([registration, precedence]) =>
    blockRendererFacet.of(registration, {precedence, source: 'defaultRenderers'}),
  ),
])
