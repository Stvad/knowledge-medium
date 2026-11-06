/** HTML documents: a block typed `html-document` holds an HTML document and
 *  renders it, scripts and styles included, in a sandbox that cannot see or
 *  touch the app (`frameDocument.ts`). */

import {blockContentRendererFacet, blockLayoutFacet} from '@/extensions/blockInteraction.js'
import {actionsFacet} from '@/extensions/core.js'
import type {AppExtension} from '@/facets/facet.js'
import {systemToggle} from '@/facets/togglable.js'
import {htmlDocumentActions} from './actions.ts'
import {htmlDocumentDataExtension} from './dataExtension.ts'
import {htmlDocumentContentContribution, htmlDocumentReferenceLayout} from './HtmlDocumentContent.tsx'

export {HTML_DOCUMENT_TYPE} from './blockType.ts'

const SOURCE = 'html-document'

export const htmlDocumentPlugin: AppExtension = systemToggle({
  id: 'system:html-document',
  name: 'HTML documents',
  description: 'Tag a block "HTML document" to render its content as a page with scripts and styles, in a sandbox with no access to the app.',
}).of([
  htmlDocumentDataExtension,
  // Over the outliner's editing dispatcher and the references plugin's layout,
  // both of which this replaces for these blocks.
  blockContentRendererFacet.of(htmlDocumentContentContribution, {source: SOURCE, precedence: 10}),
  blockLayoutFacet.of(htmlDocumentReferenceLayout, {source: SOURCE, precedence: 10}),
  htmlDocumentActions.map(action => actionsFacet.of(action, {source: SOURCE})),
])
