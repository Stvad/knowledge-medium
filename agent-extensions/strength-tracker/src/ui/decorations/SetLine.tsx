/** A set block, rendered as its numbers.
 *
 *  The decoration renders INSTEAD of the block's text, not beside it. That is
 *  the point: `strength:weight` / `strength:reps` are what progression reads,
 *  and a free-text line beside them is a second place the same fact can be
 *  written. Editing the numbers here writes both (see `editSet`), so the text
 *  stays a faithful human-readable copy rather than a rival source of truth.
 *
 *  Done-ness is NOT here — the built-in todo checkbox already renders it, and
 *  re-implementing it would give a set two different ways to be ticked.
 */

import type {ComponentType} from 'react'

import type {Block} from '@/data/block.js'
import {typesProp} from '@/data/properties.js'
import {usePropertyValue} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import {SET_TYPE} from '../../km/fields'
import {editSet} from '../../km/session'
import {repsProp, sideProp, unitProp, weightProp} from '../../km/schema'

/** Load steps in the unit the set records. Deliberately not read from the
 *  plan's `roundTo`: this is a thumb on a phone correcting a number, not a
 *  prescription, and a plate you can actually add is the useful increment. */
const weightStep = (unit: string): number => (unit === 'kg' ? 2.5 : 5)

interface StepperProps {
  label: string
  value: number
  step: number
  onChange: (next: number) => void
  suffix?: string
}

const Stepper = ({label, value, step, onChange, suffix}: StepperProps) => (
  <span className="inline-flex items-center gap-1">
    <button
      type="button"
      aria-label={`${label} down`}
      data-block-interaction="ignore"
      className="h-8 w-8 shrink-0 rounded border border-border text-base leading-none text-muted-foreground hover:bg-accent"
      onClick={event => {
        event.stopPropagation()
        onChange(Math.max(0, value - step))
      }}
    >−</button>
    <span className="min-w-[3.5ch] text-center tabular-nums">{value}{suffix}</span>
    <button
      type="button"
      aria-label={`${label} up`}
      data-block-interaction="ignore"
      className="h-8 w-8 shrink-0 rounded border border-border text-base leading-none text-muted-foreground hover:bg-accent"
      onClick={event => {
        event.stopPropagation()
        onChange(value + step)
      }}
    >+</button>
  </span>
)

const SetControls = ({block}: {block: Block}) => {
  const [weight] = usePropertyValue(block, weightProp)
  const [reps] = usePropertyValue(block, repsProp)
  const [side] = usePropertyValue(block, sideProp)
  const [unit] = usePropertyValue(block, unitProp)

  const readOnly = block.repo.isReadOnly
  const write = (patch: {weight?: number; reps?: number}) => {
    if (readOnly) return
    void editSet(block.repo, block.id, patch)
  }

  if (readOnly) {
    return (
      <span className="tabular-nums">
        {side ? `${side} ` : ''}{weight ?? 0}{unit ?? ''} × {reps ?? 0}
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {side ? (
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{side}</span>
      ) : null}
      <Stepper
        label="Weight"
        value={weight ?? 0}
        step={weightStep(unit ?? '')}
        suffix={unit ?? ''}
        onChange={next => write({weight: next})}
      />
      <span className="text-muted-foreground">×</span>
      <Stepper label="Reps" value={reps ?? 0} step={1} onChange={next => write({reps: next})}/>
    </span>
  )
}

interface DecoratorProps extends BlockRendererProps {
  Inner: BlockRenderer
}

const SetLine = ({block, Inner}: DecoratorProps) => {
  const [types] = usePropertyValue(block, typesProp)
  if (!types.includes(SET_TYPE)) return <Inner block={block}/>
  return <SetControls block={block}/>
}

const cache = new WeakMap<BlockRenderer, BlockRenderer>()

export const decorateSetContent = (inner: BlockRenderer): BlockRenderer => {
  const cached = cache.get(inner)
  if (cached) return cached
  const Decorated: ComponentType<{block: Block}> = ({block}) => <SetLine block={block} Inner={inner}/>
  Decorated.displayName = 'StrengthSetLine'
  cache.set(inner, Decorated)
  return Decorated
}
