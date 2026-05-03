import {
  blockContentDecoratorsFacet,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { UpdateIndicator } from './UpdateIndicator.tsx'

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

export const updateIndicatorPlugin: AppExtension = [
  blockContentDecoratorsFacet.of(updateIndicatorDecorator, {source: 'update-indicator'}),
]
