import {
  codeMirrorExtensionsFacet,
  completionSourcesFacet,
} from '@/extensions/editor.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import {
  blockrefCompletionSourceContribution,
  referencesCodeMirrorExtensions,
  wikilinkCompletionSourceContribution,
} from './codeMirrorExtensions.ts'
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
  completionSourcesFacet.of(wikilinkCompletionSourceContribution, {source: 'references'}),
  completionSourcesFacet.of(blockrefCompletionSourceContribution, {source: 'references'}),
])
