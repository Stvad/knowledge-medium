import type {AppExtension} from '@/facets/facet.js'
import {systemToggle} from '@/facets/togglable.js'
import {blockContentDecoratorsFacet, blockGutterItemsFacet} from '@/extensions/blockInteraction.js'
import {codeMirrorExtensionsFacet} from '@/editor/codeMirrorExtensions.js'
import {contributorsDataExtension} from './dataExtension.js'
import {contributorBadgeItemContribution, contributorCardDecoratorContribution} from './ContributorBadges.js'
import {contributorsCodeMirrorExtensions} from './codeMirrorExtensions.js'

export const contributorsPlugin: AppExtension = systemToggle({
  id: 'system:contributors',
  name: 'Contributors',
  description: 'Show quiet authorship badges for agent and automation contributions, and mention contributors with @.',
}).of([
  contributorsDataExtension,
  blockGutterItemsFacet.of(contributorBadgeItemContribution, {source: 'contributors'}),
  blockContentDecoratorsFacet.of(contributorCardDecoratorContribution, {source: 'contributors'}),
  codeMirrorExtensionsFacet.of(contributorsCodeMirrorExtensions, {source: 'contributors'}),
])
