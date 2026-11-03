import { codeMirrorExtensionsFacet } from '@/editor/codeMirrorExtensions.js'
import { blockLayoutFacet } from '@/extensions/blockInteraction.js'
import { referenceLayoutContribution } from '@/components/references/referenceLayout.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import { referencesCodeMirrorExtensions } from './codeMirrorExtensions.ts'
import { referencesDataExtension } from './dataExtension.ts'
import { referencesMarkdownExtension } from './markdown/index.ts'

export const referencesPlugin: AppExtension = systemToggle({
  id: 'system:references',
  name: 'References',
  description: 'Wikilink + block-ref parsing, the reference layout, and the wikilink display decorator.',
}).of([
  referencesDataExtension,
  markdownExtensionsFacet.of(referencesMarkdownExtension, {source: 'references'}),
  blockLayoutFacet.of(referenceLayoutContribution, {source: 'references'}),
  codeMirrorExtensionsFacet.of(referencesCodeMirrorExtensions, {source: 'references'}),
])
