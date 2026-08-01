/** ± controls beside a set block, for correcting a load under a barbell.
 *
 *  The controls sit BESIDE the block's own content, never instead of it. The
 *  set's checkbox is the todo plugin's, rendered by a decorator further down
 *  this same chain — ours wraps it, so dropping `Inner` would delete the one
 *  gesture the whole extension is built around, along with the text editor,
 *  the type chips and everything else contributed below.
 *
 *  Reps are nudged only — ±1 is the whole range of the gesture. Weight also
 *  takes a typed value, because a lift with no history stamps at 0 and
 *  dialling that to 135 with a button is 27 taps.
 */

import {useState} from 'react'

import {cachedContentDecorator} from '@/extensions/blockInteraction.js'
import {usePropertyValue} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import {adjustSet} from '../../km/session'
import {unitProp, weightProp} from '../../km/schema'

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

const REFUSED: Record<'closed' | 'gone', string> = {
  closed: 'That session is finished — reopen it to change what it records.',
  gone: 'That set is no longer there.',
}

const SetLine = ({block, Inner}: Props) => {
  const [unit] = usePropertyValue(block, unitProp)
  const [weight] = usePropertyValue(block, weightProp)
  const [problem, setProblem] = useState<string | null>(null)
  /** Keystrokes live here until blur, so the shared block never holds a
   *  half-typed number and nothing has to reconcile one. */
  const [typing, setTyping] = useState<string | null>(null)
  const step = weightStep(unit ?? '')

  const write = (patch: Parameters<typeof adjustSet>[2]) => {
    setProblem(null)
    adjustSet(block.repo, block.id, patch)
      // Refusals are the whole point of having them: dropped on the floor,
      // the buttons look live on a finished session and silently do nothing.
      .then(outcome => setProblem(outcome === 'written' ? null : REFUSED[outcome]))
      .catch((error: unknown) => {
        console.error('[strength] could not adjust the set', error)
        setProblem('Could not save that — try again.')
      })
  }

  // Deltas, so a burst of taps composes instead of each one re-sending an
  // absolute value computed from whichever render it happened to see.
  const nudge = (delta: {weight?: number; reps?: number}) => () => write(delta)

  const commitTyped = () => {
    const raw = typing
    setTyping(null)
    if (raw === null) return
    const next = Number(raw)
    // A blank or unparseable field reverts rather than writing 0 — a set
    // recorded at zero reads as a real lift you did with an empty bar.
    if (raw.trim() === '' || !Number.isFinite(next) || next === weight) return
    write({set: {weight: next}})
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <div className="min-w-0 flex-1"><Inner block={block}/></div>
      {problem ? <span className="text-xs text-destructive">{problem}</span> : null}
      {block.repo.isReadOnly ? null : (
        <div className="flex shrink-0 items-center gap-1">
          <Nudge label={`Reduce weight by ${step}${unit ?? ''}`} onPress={nudge({weight: -step})}>−</Nudge>
          {/* Typed, not only nudged: a lift with no history stamps at 0, and
              dialling that to 135 with the ± button is 27 taps. Local state
              until commit, so a half-typed number is never written. */}
          <input
            type="number"
            inputMode="decimal"
            aria-label="Weight"
            data-block-interaction="ignore"
            className="h-7 w-14 rounded border border-border bg-transparent px-1 text-center text-xs tabular-nums"
            value={typing ?? String(weight ?? 0)}
            onClick={event => event.stopPropagation()}
            onChange={event => setTyping(event.currentTarget.value)}
            onBlur={() => commitTyped()}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setTyping(null)
            }}
          />
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
