import {
  BlockChildrenFooterContribution,
  blockChildrenFooterFacet,
} from '@/extensions/blockInteraction.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import { wikilinkMarkdownExtension } from '@/markdown/wikilinks/index.tsx'
import { blockrefMarkdownExtension } from '@/markdown/blockrefs/index.tsx'
import { LinkedReferences } from './LinkedReferences.tsx'
import { backlinksDataExtension } from './dataExtension.ts'
import { backlinksCodeMirrorExtensions } from './codeMirrorExtensions.ts'

// Show "Linked References" only when the block is the zoom-in target. Roam-
// style: backlinks live with the page you're viewing, not inline beside every
// nested bullet.
const linkedReferencesContribution: BlockChildrenFooterContribution = (context) => {
  if (!context.isTopLevel) return null
  return LinkedReferences
}

export const backlinksPlugin: AppExtension = [
  backlinksDataExtension,
  markdownExtensionsFacet.of(wikilinkMarkdownExtension, {source: 'backlinks'}),
  markdownExtensionsFacet.of(blockrefMarkdownExtension, {source: 'backlinks'}),
  codeMirrorExtensionsFacet.of(backlinksCodeMirrorExtensions, {source: 'backlinks'}),
  blockChildrenFooterFacet.of(linkedReferencesContribution, {source: 'backlinks'}),
]
