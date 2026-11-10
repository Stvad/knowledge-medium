import type {AppExtension} from '@/facets/facet.js'
import {systemToggle} from '@/facets/togglable.js'
import {blockContentDecoratorsFacet} from '@/extensions/blockInteraction.js'
import {codeMirrorExtensionsFacet} from '@/editor/codeMirrorExtensions.js'
import {contributorsDataExtension} from './dataExtension.js'
import {contributorBadgesDecoratorContribution} from './ContributorBadges.js'
import {contributorsCodeMirrorExtensions} from './codeMirrorExtensions.js'

export const contributorsPlugin: AppExtension = systemToggle({
  id: 'system:contributors',
  name: 'Contributors',
  description: 'Show quiet authorship badges for agent and automation contributions, and mention contributors with @.',
}).of([
  contributorsDataExtension,
  blockContentDecoratorsFacet.of(contributorBadgesDecoratorContribution, {source: 'contributors'}),
  codeMirrorExtensionsFacet.of(contributorsCodeMirrorExtensions, {source: 'contributors'}),
])
