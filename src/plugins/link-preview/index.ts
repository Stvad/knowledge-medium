import { blockLinkDecoratorsFacet } from '@/extensions/blockLinkDecorators.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { LinkPreviewDecorator } from './LinkPreview.tsx'

export const linkPreviewPlugin: AppExtension = systemToggle({
  id: 'system:link-preview',
  name: 'Link preview',
  description: 'Hold Alt over a block reference or page link to preview its target and children.',
}).of([
  blockLinkDecoratorsFacet.of(LinkPreviewDecorator, {source: 'link-preview'}),
])
