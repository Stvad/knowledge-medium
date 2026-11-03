import type {AppExtension} from '@/facets/facet.js'
import {systemToggle} from '@/facets/togglable.js'
import {blockContentDecoratorsFacet} from '@/extensions/blockInteraction.js'
import {contributorsDataExtension} from './dataExtension.js'
import {contributorBadgesDecoratorContribution} from './ContributorBadges.js'

export const contributorsPlugin: AppExtension = systemToggle({
  id: 'system:contributors',
  name: 'Contributors',
  description: 'Show quiet authorship badges for agent and automation contributions.',
}).of([
  contributorsDataExtension,
  blockContentDecoratorsFacet.of(contributorBadgesDecoratorContribution, {source: 'contributors'}),
])
