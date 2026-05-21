import {
  blockClickHandlersFacet,
  blockContentRendererFacet,
} from '@/extensions/blockInteraction.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import {
  blockEditingContentRenderer,
  plainOutlinerBlockClickBehavior,
} from './interactions.tsx'

export const plainOutlinerPlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Plain outliner',
  description: 'Editable text content renderer + click-to-edit behaviour used for plain text blocks.',
}, [
  blockContentRendererFacet.of(blockEditingContentRenderer, {source: 'plain-outliner'}),
  blockClickHandlersFacet.of(plainOutlinerBlockClickBehavior, {source: 'plain-outliner'}),
])
