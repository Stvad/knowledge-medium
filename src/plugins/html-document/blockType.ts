/** The `html-document` block type: `content` holds an HTML document, not
 *  markdown. Leaf module (no React) because the references plugin reads the
 *  type id: the content grammars must not run over this source. */

import {seedType, type TypeSeedDeclaration} from '@/data/api'

export const HTML_DOCUMENT_TYPE = 'html-document'

export const htmlDocumentTypeSeed: TypeSeedDeclaration = seedType({
  seedKey: 'system:html-document/type/html-document',
  revision: 1,
  id: HTML_DOCUMENT_TYPE,
  label: 'HTML document',
  description: 'The block\'s content is an HTML document, rendered in a sandboxed frame with scripts and styles but no access to the app and no ordinary network. References and backlinks are not parsed from it.',
})
