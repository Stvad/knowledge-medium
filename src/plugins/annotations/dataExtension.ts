/** Data-layer contributions for comments and annotations: the thread type and
 *  its anchor properties. Composed into `annotationsPlugin` in `./index.ts`. */

import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import type {AppExtension} from '@/facets/facet'
import {annotationPropertySeeds, annotationThreadType} from './schema.ts'

const SOURCE = 'annotations'

export const annotationsDataExtension: AppExtension = [
  annotationPropertySeeds.map(prop => definitionSeedsFacet.of(prop, {source: SOURCE})),
  typeSeedsFacet.of(annotationThreadType, {source: SOURCE}),
]
