/** An assessment result's controls: a number per side with the gap beside
 *  it, or pass / fail.
 *
 *  Beside the block's content, never instead of it — the test's name is the
 *  content, and anything typed after it stays yours. The gap is the plan's
 *  one rule over a result, so it is shown where the numbers are entered
 *  rather than computed somewhere you would have to go and look.
 */

import {useState} from 'react'

import {cachedContentDecorator} from '@/extensions/blockInteraction.js'
import {usePropertyValue} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import {asMeasure, sideGap} from '../../engine/assessment'
import {recordResult, type ResultEntry} from '../../km/assessment'
import {leftProp, measureProp, outcomeProp, rightProp} from '../../km/schema'

const UNIT = {reps: 'reps', seconds: 's', cm: 'cm'} as const

const SIDE_NAME = {L: 'left', R: 'right'} as const

/** Local state until blur, so the shared block never holds a half-typed
 *  number. Blank clears the side; anything unparseable reverts.
 *
 *  A text field, not `type="number"`: a number field reports a typo as the
 *  empty string, which would read as "clear" and drop the stored value. */
const SideInput = ({side, value, disabled, onCommit}: {
  side: 'L' | 'R'
  value: number | undefined
  disabled: boolean
  onCommit: (next: number | undefined) => void
}) => {
  const [typing, setTyping] = useState<string | null>(null)
  const commit = () => {
    const raw = typing
    setTyping(null)
    if (raw === null) return
    if (raw.trim() === '') {
      if (value !== undefined) onCommit(undefined)
      return
    }
    const next = Number(raw.trim().replace(',', '.'))
    if (!Number.isFinite(next) || next < 0 || next === value) return
    onCommit(next)
  }
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      {side}
      <input
        type="text"
        inputMode="decimal"
        aria-label={`${SIDE_NAME[side]} side`}
        data-block-interaction="ignore"
        disabled={disabled}
        className="h-7 w-14 rounded border border-border bg-transparent px-1 text-center text-xs tabular-nums text-foreground"
        value={typing ?? (value === undefined ? '' : String(value))}
        onClick={event => event.stopPropagation()}
        onChange={event => setTyping(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setTyping(null)
        }}
      />
    </label>
  )
}

interface Props extends BlockRendererProps {
  Inner: BlockRenderer
}

const AssessmentLine = ({block, Inner}: Props) => {
  const [rawMeasure] = usePropertyValue(block, measureProp)
  const [left] = usePropertyValue(block, leftProp)
  const [right] = usePropertyValue(block, rightProp)
  const [outcome] = usePropertyValue(block, outcomeProp)
  const [problem, setProblem] = useState<string | null>(null)
  const measure = asMeasure(rawMeasure)

  const write = (entry: ResultEntry) => {
    setProblem(null)
    recordResult(block.repo, block.id, entry)
      .then(outcome => setProblem(outcome === 'written' ? null : 'This is no longer a result that takes that.'))
      .catch((error: unknown) => {
        console.error('[strength] could not record the result', error)
        setProblem('Could not save that — try again.')
      })
  }

  // A block typed by hand with no measure, or one this version does not know,
  // is left as plain text rather than given controls that would guess.
  if (measure === undefined) return <Inner block={block}/>
  // Read-only still SHOWS the result — the numbers live only in these
  // properties, so dropping the controls would drop the record with them.
  const readOnly = block.repo.isReadOnly

  const gap = measure === 'pass-fail' ? undefined : sideGap(left, right)

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <div className="min-w-0 flex-1"><Inner block={block}/></div>
      {problem ? <span className="text-xs text-destructive">{problem}</span> : null}
      {measure === 'pass-fail' ? (
        <div className="flex shrink-0 items-center gap-1">
          {(['pass', 'fail'] as const).map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={outcome === value}
              disabled={readOnly}
              data-block-interaction="ignore"
              className={outcome === value
                ? 'h-7 rounded bg-primary px-2 text-xs font-medium text-primary-foreground'
                : 'h-7 rounded border border-border px-2 text-xs text-muted-foreground hover:bg-accent'}
              onClick={event => {
                event.stopPropagation()
                // Pressing the chosen one again takes it back to untested.
                write({outcome: outcome === value ? undefined : value})
              }}
            >{value === 'pass' ? 'Pass' : 'Fail'}</button>
          ))}
        </div>
      ) : (
        <div className="flex max-w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {/* The gap sits BEFORE the inputs and the unit has a fixed width, so
              the inputs keep one column down the whole battery — and on a
              narrow screen the gap wraps above them rather than pushing them
              off the edge. */}
          {gap === undefined ? null : gap.extraSetOn ? (
            <span className="rounded bg-amber-500/15 px-1 text-xs text-amber-600 dark:text-amber-400">
              {Math.round(gap.gap * 100)}% gap · extra set on the {SIDE_NAME[gap.extraSetOn]}
            </span>
          ) : (
            <span className="text-xs tabular-nums text-muted-foreground">{Math.round(gap.gap * 100)}% gap</span>
          )}
          <div className="flex shrink-0 items-center gap-2">
            <SideInput side="L" value={left} disabled={readOnly} onCommit={value => write({side: 'L', value})}/>
            <SideInput side="R" value={right} disabled={readOnly} onCommit={value => write({side: 'R', value})}/>
            <span className="w-8 text-xs text-muted-foreground">{UNIT[measure]}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export const decorateAssessmentResult = cachedContentDecorator(AssessmentLine, 'StrengthAssessmentLine')
