/** The session's tally and its one irreversible control, under the workout's
 *  children.
 *
 *  Rendered by `blockChildrenFooterFacet`, so it sits after the lifts rather
 *  than inside the workout's own line — which is where a summary of the
 *  subtree belongs, and keeps the workout block itself an ordinary editable
 *  line of text.
 */

import {useState} from 'react'

import {openDialog} from '@/utils/dialogs.js'

import type {Block} from '@/data/block.js'
import {useData, useWorkspaceId} from '@/hooks/block.js'

import {asSet, asWorkout} from '../../km/records'
import {discardCounts, type FinishOutcome} from '../../km/session'
import type {DiscardTally} from '../../km/subtree'
import {ConfirmDialog} from '../ConfirmDialog'
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
    case 'edit-failed':
      return 'A change to one of your sets did not save, so finishing now would '
        + 'record the old number. Check the set, then finish.'
    case 'changed':
      return 'This session changed while that was open — press Finish again.'
  }
}

/** Name what Discard would take, in the user's terms.
 *
 *  Both kinds, because `deleteBlock` cascades over the whole subtree and a
 *  warning that mentions only sets under-describes the deletion. "You added"
 *  is the distinction that matters: everything else down there was stamped by
 *  the Start you are undoing, and losing that is the point of the button. */
const whatGoes = ({logged, yours}: DiscardTally): string => [
  ...(logged > 0 ? [`${logged} logged ${logged === 1 ? 'set' : 'sets'}`] : []),
  ...(yours > 0 ? [`${yours} ${yours === 1 ? 'block' : 'blocks'} you added`] : []),
].join(' and ')

export const WorkoutFooter = ({block}: {block: Block}) => {
  const workspaceId = useWorkspaceId(block)
  // Through `asWorkout`, not `usePropertyValue`: `strength:status` has a schema
  // default of `in-progress`, so a block you hand-tagged as a Workout — or
  // whose status you cleared — read as live HERE while `finishSession` and
  // `discardSession` refused it as `gone` and `buildHistory` filed it as a
  // completed session. Three readers, three answers, and the two controls this
  // footer offers could never succeed. One reader now, and it is the same one
  // the writers use.
  const workout = asWorkout(useData(block))
  const {entriesOf, setsOf} = useSessionRows(workspaceId)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const lifts = entriesOf(block.id)
  const sets = lifts.flatMap(entry => [...setsOf(entry.id)])
  const done = sets.map(asSet).filter(set => set?.done === true)
  const unit = done[0]?.unit
  const volume = done.reduce((total, set) => total + (set?.weight ?? 0) * (set?.reps ?? 0), 0)

  // No early return on an empty workout. One with no direct lifts — nothing
  // stamped, every lift deleted, or every lift indented under a note — still
  // needs Discard, and still needs Finish to be reachable so it can say WHY
  // it refuses. Without them the standing-session check sends every later
  // Start back to a session with no way out of it.
  const tally = `${lifts.length} ${lifts.length === 1 ? 'lift' : 'lifts'} · `
    + `${done.length}/${sets.length} sets`
    + (volume > 0 ? ` · ${volume.toLocaleString()}${typeof unit === 'string' ? unit : ''}` : '')

  return (
    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span className="tabular-nums">{tally}</span>
      {workout?.live === true && !block.repo.isReadOnly ? (
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
      {workout?.live === true && !block.repo.isReadOnly ? (
        <button
          type="button"
          disabled={busy}
          data-block-interaction="ignore"
          className="rounded px-2 py-1 text-muted-foreground underline decoration-dotted hover:text-foreground disabled:opacity-50"
          onClick={event => {
            event.stopPropagation()
            setProblem(null)
            void (async () => {
              // Counted over the whole subtree, not the canonical positions:
              // a performed set indented under a note is still work Discard
              // destroys, and `done` above cannot see it — so the warning was
              // skipped for exactly the tree Finish refuses.
              const doomed = await discardCounts(block.repo, block.id)
              if (doomed.logged > 0 || doomed.yours > 0) {
                const go = await openDialog(ConfirmDialog, {
                  title: 'Discard this session?',
                  body: `${whatGoes(doomed)} will be deleted. This cannot be undone from here.`,
                  confirmLabel: 'Discard',
                  destructive: true,
                })
                if (!go) return
              }
              setBusy(true)
              try {
                // The counts go IN, so the delete applies to the tree that was
                // confirmed. Between the count and here sits a dialog you can
                // leave open indefinitely — and, when there was nothing to
                // warn about, no dialog but still several awaits. Either way a
                // peer can tick a set or add a block in the gap, and the
                // reading that skips the warning entirely is exactly the one
                // where anything appearing is unannounced.
                const outcome = await discardSession(block.repo, block.id, doomed)
                setProblem(
                  outcome === 'discarded' ? null
                    : outcome === 'changed'
                      ? 'This session changed while that was open — press Discard again to see what it would delete.'
                      : outcome === 'holds-a-session'
                        ? 'Another workout is filed inside this one, and discarding would delete it too. '
                          + 'Outdent it first, then discard.'
                        : 'Already closed elsewhere — nothing to discard.',
                )
              } catch (error: unknown) {
                console.error('[strength] could not discard the session', error)
                setProblem('Could not discard — the change was not saved.')
              } finally {
                setBusy(false)
              }
            })()
          }}
        >Discard</button>
      ) : null}
      {workout?.closed ? <span className="text-muted-foreground">closed</span> : null}
      {problem ? <span className="text-destructive">{problem}</span> : null}
    </div>
  )
}
