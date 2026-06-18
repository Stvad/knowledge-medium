import { codeMirrorExtensionsFacet } from '@/extensions/editor.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import { referencesCodeMirrorExtensions } from './codeMirrorExtensions.ts'
import { referencesDataExtension } from './dataExtension.ts'
import { blockrefMarkdownExtension } from './markdown/blockrefs/index.tsx'
import { wikilinkMarkdownExtension } from './markdown/wikilinks/index.tsx'

export const referencesPlugin: AppExtension = systemToggle({
  id: 'system:references',
  name: 'References',
  description: 'Wikilink + block-ref parsing and the wikilink display decorator.',
}).of([
  referencesDataExtension,
  markdownExtensionsFacet.of(wikilinkMarkdownExtension, {source: 'references'}),
  markdownExtensionsFacet.of(blockrefMarkdownExtension, {source: 'references'}),
  codeMirrorExtensionsFacet.of(referencesCodeMirrorExtensions, {source: 'references'}),
])

export default referencesPlugin
