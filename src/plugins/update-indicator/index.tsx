import {
  blockGutterItemsFacet,
  type BlockGutterItem,
  type BlockGutterItemContribution,
} from '@/extensions/blockInteraction.js'
import { appEffectsFacet } from '@/extensions/core.js'
import { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import { UpdateIndicator } from './UpdateIndicator.tsx'
import {
  currentLoadTimeProp,
  previousLoadTimeProp,
  updateIndicatorLoadTimeEffect,
  updateIndicatorPrefsType,
} from './loadTimes.ts'

// Accepted: the dot hides once the block takes focus, so the first line it
// shortened re-wraps once, on that click.
const updateIndicatorItem: BlockGutterItem = {corner: 'top-right', component: UpdateIndicator}

const updateIndicatorItemContribution: BlockGutterItemContribution = () => updateIndicatorItem

export const updateIndicatorPlugin: AppExtension = systemToggle({
  id: 'system:update-indicator',
  name: 'Update indicator',
  description: 'Subtle indicator when a new app build has been deployed since this tab loaded.',
}).of([
  appEffectsFacet.of(updateIndicatorLoadTimeEffect, {source: 'update-indicator'}),
  definitionSeedsFacet.of(previousLoadTimeProp, {source: 'update-indicator'}),
  definitionSeedsFacet.of(currentLoadTimeProp, {source: 'update-indicator'}),
  ...pluginPrefsExtension(updateIndicatorPrefsType, 'update-indicator'),
  blockGutterItemsFacet.of(updateIndicatorItemContribution, {source: 'update-indicator'}),
])
