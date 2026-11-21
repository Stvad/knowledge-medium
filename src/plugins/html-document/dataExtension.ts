/** Data-layer contributions for the html-document plugin. Composed into
 *  `htmlDocumentPlugin` in `./index.ts`. */

import {typeSeedsFacet} from '@/data/facets'
import type {AppExtension} from '@/facets/facet'
import {htmlDocumentTypeSeed} from './blockType.ts'

export const htmlDocumentDataExtension: AppExtension =
  typeSeedsFacet.of(htmlDocumentTypeSeed, {source: 'html-document'})
