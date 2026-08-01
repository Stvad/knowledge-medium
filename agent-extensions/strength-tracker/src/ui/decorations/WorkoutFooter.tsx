/** The session's tally and its one irreversible control, under the workout's
 *  children.
 *
 *  Rendered by `blockChildrenFooterFacet`, so it sits after the lifts rather
 *  than inside the workout's own line — which is where a summary of the
 *  subtree belongs, and keeps the workout block itself an ordinary editable
 *  line of text.
 */

import {useState} from 'react'

import type {Block} from '@/data/block.js'
import {usePropertyValue, useWorkspaceId} from '@/hooks/block.js'

import {FIELD} from '../../km/fields'
import type {FinishOutcome} from '../../km/session'
import {statusProp} from '../../km/schema'
import {closeSession} from '../../km/tonight'
import {discardSession} from '../../km/store'
import {useSessionRows} from './sessionRows'

const message = (outcome: FinishOutcome): string | null => {
  switch (outcome) {
    case 'done': return null
    case 'gone': return 'Already closed — another device finished or discarded this session.'
    case 'nothing-logged':
      return 'Nothing is ticked yet, so there is no training day to record. Tick the sets you did.'
    case 'undated':
      return 'This session has no readable date, so it cannot be filed on a training day. '
        + 'Set its date property, then finish.'
    case 'misfiled':
      return 'A set or a lift is indented somewhere your history cannot read it — '
        + 'outdent it so every set sits directly under its lift, then finish.'
  }
}

export const WorkoutFooter = ({block}: {block: Block}) => {
  const workspaceId = useWorkspaceId(block)
  const [status] = usePropertyValue(block, statusProp)
  const {entriesOf, setsOf} = useSessionRows(workspaceId)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const lifts = entriesOf(block.id)
  const sets = lifts.flatMap(entry => [...setsOf(entry.id)])
  const done = sets.filter(set => set.properties[FIELD.todoStatus] === 'done')
  const unit = done[0]?.properties[FIELD.unit]
  const volume = done.reduce((total, set) => {
    const weight = typeof set.properties[FIELD.weight] === 'number' ? set.properties[FIELD.weight] as number : 0
    const reps = typeof set.properties[FIELD.reps] === 'number' ? set.properties[FIELD.reps] as number : 0
    return total + weight * reps
  }, 0)

  if (lifts.length === 0) return null

  const tally = `${lifts.length} ${lifts.length === 1 ? 'lift' : 'lifts'} · `
    + `${done.length}/${sets.length} sets`
    + (volume > 0 ? ` · ${volume.toLocaleString()}${typeof unit === 'string' ? unit : ''}` : '')

  return (
    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span className="tabular-nums">{tally}</span>
      {status === 'in-progress' && !block.repo.isReadOnly ? (
        <button
          type="button"
          disabled={busy}
          data-block-interaction="ignore"
          className="rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
          onClick={event => {
            event.stopPropagation()
            setBusy(true)
            setProblem(null)
            // `closeSession`, not `finishSession`: the break this session may
            // be ending has to be recorded in the SAME transaction, and it is
            // only detectable from history as it stands before this session
            // joins it.
            void closeSession(block.repo, workspaceId, block.id)
              .then(outcome => setProblem(message(outcome)))
              .catch((error: unknown) => {
                console.error('[strength] could not finish the session', error)
                setProblem('Could not finish — the change was not saved. Try again.')
              })
              .finally(() => setBusy(false))
          }}
        >{busy ? 'Finishing…' : 'Finish'}</button>
      ) : null}
      {/* The only way out of a session started by mistake. Without it, the
          standing-session check sends every later Start back to the workout
          you did not want, and deleting blocks by hand is the only escape. */}
      {status === 'in-progress' && !block.repo.isReadOnly ? (
        <button
          type="button"
          disabled={busy}
          data-block-interaction="ignore"
          className="rounded px-2 py-1 text-muted-foreground underline decoration-dotted hover:text-foreground disabled:opacity-50"
          onClick={event => {
            event.stopPropagation()
            if (done.length > 0 && !confirm(
              `Discard this session? ${done.length} logged ${done.length === 1 ? 'set' : 'sets'} will be deleted.`,
            )) return
            setBusy(true)
            setProblem(null)
            void discardSession(block.repo, block.id)
              .then(outcome => setProblem(outcome === 'discarded'
                ? null
                : 'Already closed elsewhere — nothing to discard.'))
              .catch((error: unknown) => {
                console.error('[strength] could not discard the session', error)
                setProblem('Could not discard — the change was not saved.')
              })
              .finally(() => setBusy(false))
          }}
        >Discard</button>
      ) : null}
      {status === 'done' ? <span className="text-muted-foreground">closed</span> : null}
      {problem ? <span className="text-destructive">{problem}</span> : null}
    </div>
  )
}
