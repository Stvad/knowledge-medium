import {
  blockClickHandlersFacet,
  blockContentRendererFacet,
} from '@/extensions/blockInteraction.js'
import { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import {
  blockEditingContentRenderer,
  plainOutlinerBlockClickBehavior,
} from './interactions.tsx'

export const plainOutlinerPlugin: AppExtension = systemToggle({
  id: 'system:plain-outliner',
  name: 'Plain outliner',
  description: 'Editable text content renderer + click-to-edit behaviour used for plain text blocks.',
}).of([
  blockContentRendererFacet.of(blockEditingContentRenderer, {source: 'plain-outliner'}),
  blockClickHandlersFacet.of(plainOutlinerBlockClickBehavior, {source: 'plain-outliner'}),
])
