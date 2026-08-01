/** ± controls beside a set block, for correcting a load under a barbell.
 *
 *  The controls sit BESIDE the block's own content, never instead of it. The
 *  set's checkbox is the todo plugin's, rendered by a decorator further down
 *  this same chain — ours wraps it, so dropping `Inner` would delete the one
 *  gesture the whole extension is built around, along with the text editor,
 *  the type chips and everything else contributed below.
 *
 *  Which is also why the buttons show no numbers: the block's text already
 *  says `135lb × 8`, and `adjustSet` rewrites that text from the properties
 *  on every tap. One place to read the value, one place to change it.
 */

import type {Block} from '@/data/block.js'
import {cachedContentDecorator} from '@/extensions/blockInteraction.js'
import {usePropertyValue} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import {adjustSet} from '../../km/session'
import {unitProp} from '../../km/schema'

/** Load steps in the unit the set records. Deliberately not the plan's
 *  `roundTo`: this is a thumb correcting a number, and a plate you can
 *  actually add is the useful increment. */
const weightStep = (unit: string): number => (unit === 'kg' ? 2.5 : 5)

const Nudge = ({label, onPress, children}: {
  label: string
  onPress: () => void
  children: string
}) => (
  <button
    type="button"
    aria-label={label}
    data-block-interaction="ignore"
    className="h-7 min-w-7 shrink-0 rounded border border-border px-1 text-xs leading-none text-muted-foreground hover:bg-accent"
    onClick={event => {
      event.stopPropagation()
      onPress()
    }}
  >{children}</button>
)

interface Props extends BlockRendererProps {
  Inner: BlockRenderer
}

const SetLine = ({block, Inner}: Props) => {
  const [unit] = usePropertyValue(block, unitProp)
  const step = weightStep(unit ?? '')
  // Deltas, so a burst of taps composes instead of each one re-sending an
  // absolute value computed from whichever render it happened to see.
  const nudge = (delta: {weight?: number; reps?: number}) => () => {
    void adjustSet(block.repo, block.id, delta)
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <div className="min-w-0 flex-1"><Inner block={block}/></div>
      {block.repo.isReadOnly ? null : (
        <div className="flex shrink-0 items-center gap-1">
          <Nudge label={`Reduce weight by ${step}${unit ?? ''}`} onPress={nudge({weight: -step})}>−</Nudge>
          <Nudge label={`Add ${step}${unit ?? ''} of weight`} onPress={nudge({weight: step})}>+</Nudge>
          <span aria-hidden className="px-0.5 text-xs text-muted-foreground">reps</span>
          <Nudge label="One rep fewer" onPress={nudge({reps: -1})}>−</Nudge>
          <Nudge label="One rep more" onPress={nudge({reps: 1})}>+</Nudge>
        </div>
      )}
    </div>
  )
}

export const decorateSetContent = cachedContentDecorator(SetLine, 'StrengthSetLine')
