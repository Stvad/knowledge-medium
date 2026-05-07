import { AppExtension } from '@/extensions/facet.ts'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import { wikilinkMarkdownExtension } from '@/markdown/wikilinks/index.tsx'
import { blockrefMarkdownExtension } from '@/markdown/blockrefs/index.tsx'
import { backlinksViewFacet } from '@/plugins/backlinks-view/facet.ts'
import { defineVariant } from '@/extensions/variantFacet.ts'
import { LinkedReferences } from './LinkedReferences.tsx'
import { backlinksDataExtension } from './dataExtension.ts'
import { backlinksCodeMirrorExtensions } from './codeMirrorExtensions.ts'

// Show "Linked References" only when the block is the zoom-in target. Roam-
// style: backlinks live with the page you're viewing, not inline beside every
// nested bullet. The top-level gate is enforced by the backlinks-view
// coordinator's footer contribution; this variant always offers itself.
export const backlinksPlugin: AppExtension = [
  backlinksDataExtension,
  markdownExtensionsFacet.of(wikilinkMarkdownExtension, {source: 'backlinks'}),
  markdownExtensionsFacet.of(blockrefMarkdownExtension, {source: 'backlinks'}),
  codeMirrorExtensionsFacet.of(backlinksCodeMirrorExtensions, {source: 'backlinks'}),
  backlinksViewFacet.of(
    () => defineVariant('flat', 'Flat', LinkedReferences),
    {source: 'backlinks'},
  ),
]
