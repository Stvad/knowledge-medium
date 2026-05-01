import { Breadcrumbs } from '@/components/Breadcrumbs.tsx'
import { BreadcrumbRenderer } from '@/components/renderer/BreadcrumbRenderer.tsx'
import { CodeMirrorExtensionBlockRenderer } from '@/components/renderer/CodeMirrorExtensionBlockRenderer.tsx'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.tsx'
import { MissingDataRenderer } from '@/components/renderer/MissingDataRenderer.tsx'
import { PanelRenderer } from '@/components/renderer/PanelRenderer.tsx'
import { TopLevelRenderer } from '@/components/renderer/TopLevelRenderer.tsx'
import { blockHeaderFacet } from '@/extensions/blockInteraction.ts'
import { blockRenderersFacet, createRendererRegistry, RendererContribution } from '@/extensions/core.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.ts'
import { wikilinkMarkdownExtension } from '@/markdown/wikilinks/index.tsx'
import { blockrefMarkdownExtension } from '@/markdown/blockrefs/index.tsx'

export const defaultRendererContributions: RendererContribution[] = [
  {id: 'default', renderer: DefaultBlockRenderer},
  {id: 'extension', renderer: CodeMirrorExtensionBlockRenderer},
  {id: 'topLevel', renderer: TopLevelRenderer},
  {id: 'layout', renderer: LayoutRenderer},
  {id: 'panel', renderer: PanelRenderer},
  {id: 'missingData', renderer: MissingDataRenderer},
  {id: 'breadcrumb', renderer: BreadcrumbRenderer},
]

export const defaultRegistry = createRendererRegistry(defaultRendererContributions)

export const defaultRenderersExtension = [
  markdownExtensionsFacet.of(gfmMarkdownExtension, {source: 'defaultRenderers'}),
  markdownExtensionsFacet.of(wikilinkMarkdownExtension, {source: 'defaultRenderers'}),
  markdownExtensionsFacet.of(blockrefMarkdownExtension, {source: 'defaultRenderers'}),
  ...defaultRendererContributions.map(contribution =>
    blockRenderersFacet.of(contribution),
  ),
  // Header section: top-level breadcrumbs. Self-gates on isTopLevel so
  // non-top-level blocks pay no header cost.
  blockHeaderFacet.of(
    ctx => ctx.isTopLevel ? Breadcrumbs : null,
    {source: 'defaultRenderers'},
  ),
]
