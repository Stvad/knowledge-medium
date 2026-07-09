import { BlockTypeBlockRenderer } from '@/components/renderer/BlockTypeBlockRenderer.js'
import { CodeMirrorExtensionBlockRenderer } from '@/components/renderer/CodeMirrorExtensionBlockRenderer.js'
import { DefaultBlockRenderer, expandCollapseLineEndAccessoryContribution } from '@/components/renderer/DefaultBlockRenderer.js'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.js'
import { MissingDataRenderer } from '@/components/renderer/MissingDataRenderer.js'
import { PanelRenderer } from '@/components/renderer/PanelRenderer.js'
import { PropertySchemaBlockRenderer } from '@/components/renderer/PropertySchemaBlockRenderer.js'
import { TopLevelRenderer } from '@/components/renderer/TopLevelRenderer.js'
import { TypesPageBlockRenderer } from '@/components/renderer/TypesPageBlockRenderer.js'
import { blockRenderersFacet, createRendererRegistry, RendererContribution } from '@/extensions/core.js'
import { blockLineEndAccessoriesFacet } from '@/extensions/blockInteraction.js'
import { systemToggle } from '@/facets/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.js'

export const defaultRendererContributions: RendererContribution[] = [
  {id: 'default', renderer: DefaultBlockRenderer},
  {id: 'extension', renderer: CodeMirrorExtensionBlockRenderer},
  {id: 'propertySchema', renderer: PropertySchemaBlockRenderer},
  {id: 'blockType', renderer: BlockTypeBlockRenderer},
  {id: 'typesPage', renderer: TypesPageBlockRenderer},
  {id: 'topLevel', renderer: TopLevelRenderer},
  {id: 'layout', renderer: LayoutRenderer},
  {id: 'panel', renderer: PanelRenderer},
  {id: 'missingData', renderer: MissingDataRenderer},
]

export const defaultRegistry = createRendererRegistry(defaultRendererContributions)

export const defaultRenderersExtension = systemToggle({
  id: 'system:default-renderers',
  name: 'Default renderers',
  description: 'Block renderer registry and the fallback renderer used when no plugin claims a block.',
  essential: true,
}).of([
  markdownExtensionsFacet.of(gfmMarkdownExtension, {source: 'defaultRenderers'}),
  blockLineEndAccessoriesFacet.of(expandCollapseLineEndAccessoryContribution, {source: 'defaultRenderers', precedence: -100}),
  ...defaultRendererContributions.map(contribution =>
    blockRenderersFacet.of(contribution),
  ),
])
