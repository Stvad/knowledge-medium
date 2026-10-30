/** Data-layer contributions for comments and annotations: the thread type, its
 *  anchor properties and the backlink edges threads own. Composed into
 *  `annotationsPlugin` in `./index.ts`. */

import {definitionSeedsFacet, queriesFacet, typeSeedsFacet} from '@/data/facets'
import type {AppExtension} from '@/facets/facet'
import {backlinkEdgeExclusionsFacet} from '@/plugins/backlinks/edgeExclusions.js'
import {annotationMarginOpenProp} from './marginSchema.ts'
import {threadIdsForBlockQuery} from './queries.ts'
import {threadsInScopeQuery} from './scopeThreads.ts'
import {threadsForBlockQuery} from './summaries.ts'
import {annotationPropertySeeds, annotationTargetProp, annotationThreadType, THREAD_TYPE} from './schema.ts'

const SOURCE = 'annotations'

export const annotationsDataExtension: AppExtension = [
  annotationPropertySeeds.map(prop => definitionSeedsFacet.of(prop, {source: SOURCE})),
  definitionSeedsFacet.of(annotationMarginOpenProp, {source: SOURCE}),
  typeSeedsFacet.of(annotationThreadType, {source: SOURCE}),
  queriesFacet.of(threadIdsForBlockQuery, {source: SOURCE}),
  queriesFacet.of(threadsForBlockQuery, {source: SOURCE}),
  queriesFacet.of(threadsInScopeQuery, {source: SOURCE}),
  // A thread is not a mention of its target: it shows as a thread there.
  backlinkEdgeExclusionsFacet.of({kind: 'field', field: annotationTargetProp.name}, {source: SOURCE}),
  // A root's content is a quote of its target, not the thread's own text, so a
  // `[[Page]]` inside it mentions nothing. Comments' own references still count.
  backlinkEdgeExclusionsFacet.of({kind: 'content-from-type', type: THREAD_TYPE}, {source: SOURCE}),
]
