import {
  blockClickHandlersFacet,
  blockContentRendererFacet,
} from '@/extensions/blockInteraction.ts'
import { AppExtension } from '@/extensions/facet.ts'
import {
  blockEditingContentRenderer,
  plainOutlinerBlockClickBehavior,
} from './interactions.tsx'

export const plainOutlinerPlugin: AppExtension = [
  blockContentRendererFacet.of(blockEditingContentRenderer, {source: 'plain-outliner'}),
  blockClickHandlersFacet.of(plainOutlinerBlockClickBehavior, {source: 'plain-outliner'}),
]
