import {
  blockContentRendererFacet,
} from '@/extensions/blockInteraction.js'
import { actionsFacet } from '@/extensions/core.js'
import { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { blockEditingContentRenderer } from './interactions.tsx'
import { enterBlockEditModeOnClickAction } from './clickToEditAction.ts'

export const plainOutlinerPlugin: AppExtension = systemToggle({
  id: 'system:plain-outliner',
  name: 'Plain outliner',
  description: 'Editable text content renderer + click-to-edit behaviour used for plain text blocks.',
}).of([
  blockContentRendererFacet.of(blockEditingContentRenderer, {source: 'plain-outliner'}),
  // Click-to-edit as a pointer-bound action dispatched through resolve, rather
  // than a blockClickHandlersFacet contribution that silently last-wins.
  actionsFacet.of(enterBlockEditModeOnClickAction, {source: 'plain-outliner'}),
])
