/** "Taken now" under a dose block: ticks the todo and stamps when, so the
 *  native checkbox and this button always agree — the checkbox itself IS
 *  adherence, and `markDoseTaken` sets it together with the time in one
 *  transaction. Modelled on the Strength Tracker's `SetLine`.
 *
 *  Exports only the raw component — `cachedContentDecorator` is called in
 *  `./index`, so this module never touches `@/extensions/blockInteraction.js`
 *  itself; see `NightLine`'s doc for why that split matters under the unit
 *  tier's kernel-type stubs.
 */
import {useState} from 'react'

import {useData, usePropertyValue} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import {FIELD} from '../../km/fields'
import {markDoseTaken, type WriteOutcome} from '../../km/nights'
import {takenAtProp} from '../../km/schema'

interface Props extends BlockRendererProps {
  Inner: BlockRenderer
}

const REFUSED: Record<WriteOutcome, string | null> = {
  written: null,
  gone: 'That dose is no longer there.',
}

const hhmm = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Exported directly (not just the decorated wrapper below) so a render
 *  test can mount it without going through `cachedContentDecorator` — no
 *  runtime under the unit tier's kernel-type stubs, same as `NightLine`. */
export const DoseLine = ({block, Inner}: Props) => {
  // RAW, not `usePropertyValue`: the todo checkbox is the plugin's own
  // control, and this button must read exactly what it last set rather than
  // a schema-default fallback that could disagree with it — same concern as
  // `SetLine`'s raw read of `strength:unit`.
  const done = useData(block)?.properties[FIELD.todoStatus] === 'done'
  const [takenAt] = usePropertyValue(block, takenAtProp)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1"><Inner block={block}/></div>
      {!done && !block.repo.isReadOnly ? (
        <button
          type="button"
          disabled={busy}
          data-block-interaction="ignore"
          className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
          onClick={event => {
            event.stopPropagation()
            setBusy(true)
            setProblem(null)
            markDoseTaken(block.repo, block.id)
              .then(outcome => setProblem(REFUSED[outcome]))
              .catch((error: unknown) => {
                console.error('[sleep-lab] could not mark the dose taken', error)
                setProblem('Could not save that — try again.')
              })
              .finally(() => setBusy(false))
          }}
        >{busy ? 'Saving…' : 'Taken now'}</button>
      ) : null}
      {done && takenAt !== undefined ? <span className="text-xs text-muted-foreground">{hhmm(takenAt)}</span> : null}
      {problem ? <span className="text-xs text-destructive">{problem}</span> : null}
    </div>
  )
}
