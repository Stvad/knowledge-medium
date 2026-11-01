import {definitionSeedsFacet, queriesFacet, sameTxProcessorsFacet, typeSeedsFacet} from '@/data/facets'
import type {AppExtension} from '@/facets/facet'
import {contributorAttributionProcessor} from './processor'
import {contributorProfilesByIdsQuery} from './queries'
import {
  attributionCreatorsProp, attributionEditorsProp, contributorForProp,
  contributorKindProp, contributorProfileType, contributorRoleProp,
} from './schema'

export const contributorProfilesQueryExtension = queriesFacet.of(contributorProfilesByIdsQuery, {source: 'contributors'})

export const contributorsDataExtension: AppExtension = [
  [attributionCreatorsProp, attributionEditorsProp, contributorForProp,
    contributorKindProp, contributorRoleProp].map(prop =>
    definitionSeedsFacet.of(prop, {source: 'contributors'})),
  typeSeedsFacet.of(contributorProfileType, {source: 'contributors'}),
  contributorProfilesQueryExtension,
  sameTxProcessorsFacet.of(contributorAttributionProcessor, {source: 'contributors'}),
]
