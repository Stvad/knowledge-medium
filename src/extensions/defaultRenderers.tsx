import { BreadcrumbRenderer } from '@/components/renderer/BreadcrumbRenderer.tsx'
import { CodeMirrorRendererBlockRenderer } from '@/components/renderer/CodeMirrorRendererBlockRenderer.tsx'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.tsx'
import { MissingDataRenderer } from '@/components/renderer/MissingDataRenderer.tsx'
import { PanelRenderer } from '@/components/renderer/PanelRenderer.tsx'
import { TopLevelRenderer } from '@/components/renderer/TopLevelRenderer.tsx'
import { VideoPlayerRenderer } from '@/components/renderer/VideoPlayerRenderer.tsx'
import { blockRenderersFacet, createRendererRegistry, RendererContribution } from '@/extensions/core.ts'

export const defaultRendererContributions: RendererContribution[] = [
  {id: 'default', renderer: DefaultBlockRenderer},
  {id: 'renderer', renderer: CodeMirrorRendererBlockRenderer},
  {id: 'topLevel', renderer: TopLevelRenderer},
  {id: 'layout', renderer: LayoutRenderer},
  {id: 'panel', renderer: PanelRenderer},
  {id: 'videoPlayer', renderer: VideoPlayerRenderer},
  {id: 'missingData', renderer: MissingDataRenderer},
  {id: 'breadcrumb', renderer: BreadcrumbRenderer},
]

export const defaultRegistry = createRendererRegistry(defaultRendererContributions)

export const defaultRenderersExtension = defaultRendererContributions.map(contribution =>
  blockRenderersFacet.of(contribution),
)
