import { codeMirrorExtensionsFacet } from '@/extensions/editor.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import { referencesCodeMirrorExtensions } from './codeMirrorExtensions.ts'
import { referencesDataExtension } from './dataExtension.ts'
import { blockrefMarkdownExtension } from './markdown/blockrefs/index.tsx'
import { wikilinkMarkdownExtension } from './markdown/wikilinks/index.tsx'

export const referencesPlugin: AppExtension = [
  referencesDataExtension,
  markdownExtensionsFacet.of(wikilinkMarkdownExtension, {source: 'references'}),
  markdownExtensionsFacet.of(blockrefMarkdownExtension, {source: 'references'}),
  codeMirrorExtensionsFacet.of(referencesCodeMirrorExtensions, {source: 'references'}),
]
