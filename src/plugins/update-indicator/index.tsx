import {
  blockContentDecoratorsFacet,
  type BlockContentDecoratorContribution,
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

// Wrap the block's content in a positioned ancestor and overlay the
// update-indicator dot. Doing this as a content decorator rather than a
// layout slot means custom layouts compose with it for free — they don't
// need to remember to render an indicator anywhere themselves.
const updateIndicatorDecorator: BlockContentDecoratorContribution = () => Inner => {
  const Decorated: React.FC<{ block: import('../../data/block').Block }> = (props) => (
    <div className="relative">
      <UpdateIndicator block={props.block}/>
      {/* Inner is the registry-resolved/decorated renderer; identity is
          stable per blockInteractionContext. */}
      <Inner {...props}/>
    </div>
  )
  Decorated.displayName = 'WithUpdateIndicator'
  return Decorated
}

export const updateIndicatorPlugin: AppExtension = systemToggle({
  id: 'system:update-indicator',
  name: 'Update indicator',
  description: 'Subtle indicator when a new app build has been deployed since this tab loaded.',
}).of([
  appEffectsFacet.of(updateIndicatorLoadTimeEffect, {source: 'update-indicator'}),
  definitionSeedsFacet.of(previousLoadTimeProp, {source: 'update-indicator'}),
  definitionSeedsFacet.of(currentLoadTimeProp, {source: 'update-indicator'}),
  ...pluginPrefsExtension(updateIndicatorPrefsType, 'update-indicator'),
  blockContentDecoratorsFacet.of(updateIndicatorDecorator, {source: 'update-indicator'}),
])
