/** What a lift is asking of you tonight, under the lift's own block.
 *
 *  Computed on every render and never written. That is the line this design
 *  draws: the engine's SUGGESTION is rendered, so it cannot go stale and
 *  cannot be hand-edited into something false, while the numbers on the set
 *  blocks below are stored — those are your intent for tonight, an input you
 *  override by tapping, not a cache of a computation.
 */

import {useMemo} from 'react'

import type {Block} from '@/data/block.js'
import {cachedContentDecorator} from '@/extensions/blockInteraction.js'
import {useContent, useData, usePropertyValue, useWorkspaceId} from '@/hooks/block.js'
import type {BlockRenderer} from '@/types.js'

import {lastEntryFor, progressionSets, workingWeight} from '../../engine/progression'
import {compareRecords} from '../../engine/types'
import {dateToDay} from '../../km/day'
import {FIELD} from '../../km/fields'
import {
  definitionProp,
  exerciseProp,
  occurrenceProp,
  prescribedSetsProp,
  prescribedWeightProp,
  unitProp,
} from '../../km/schema'
import {useSessionRows} from './sessionRows'

const LiftSummary = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const workspaceId = useWorkspaceId(block)
  const [exercise] = usePropertyValue(block, exerciseProp)
  const [definitionId] = usePropertyValue(block, definitionProp)
  const [occurrence] = usePropertyValue(block, occurrenceProp)
  const [prescribedSets] = usePropertyValue(block, prescribedSetsProp)
  const [prescribedWeight] = usePropertyValue(block, prescribedWeightProp)
  const [unit] = usePropertyValue(block, unitProp)
  const content = useContent(block)
  const {history, setsOf} = useSessionRows(workspaceId)

  const sets = setsOf(block.id)
  const done = sets.filter(set => set.properties[FIELD.todoStatus] === 'done').length

  // Everything except the session this entry is IN. `history` holds every
  // finished workout, so the moment you tap Finish this lookup returns the
  // very entry it is describing and the line reports tonight as "last time";
  // opened on an older session it reports a later one. Both are worse than
  // saying nothing, because that number is what you lift against.
  //
  // "Last time" otherwise comes from the same matcher progression uses, so
  // what the line says and what the next prescription is built from cannot
  // disagree. The name falls back to the block's own text: an entry
  // hand-typed into the outline has no `strength:exercise` yet, and "no
  // history" would be a wronger answer than matching what it plainly says.
  const workoutId = useData(block)?.parentId ?? null
  const earlier = useMemo(() => {
    const mine = history.find(workout => workout.id === workoutId)
    // Excluding this workout by id alone still leaves every LATER one in, and
    // `lastEntryFor` takes the newest — so opening an old session labelled a
    // future performance as "last time". Chronology, not inequality. An
    // in-progress session is not in `history` at all, so it compares against
    // everything, which is right.
    return mine === undefined
      ? history
      // `compareRecords`, not `<` on the date: two sessions of one training
      // day share the same noon-backed `date`, so a strict comparison hid the
      // morning one from the evening one entirely. That comparator is what
      // progression orders by — day first, completion time only inside it — so
      // the line and the next prescription agree about which came first.
      : history.filter(workout =>
        workout.id !== workoutId && compareRecords(workout, mine) < 0)
  }, [history, workoutId])
  const previous = lastEntryFor(earlier, exercise ?? content, definitionId, occurrence ?? 0)
  const previousWeight = previous ? workingWeight(previous.entry) : undefined

  const parts: string[] = []
  if (sets.length > 0) parts.push(`${done}/${sets.length} done`)
  if (prescribedSets !== undefined) {
    parts.push(`target ${prescribedSets}×${sets[0]?.properties[FIELD.reps] ?? '?'}`
      + (prescribedWeight !== undefined ? ` @ ${prescribedWeight}${unit ?? ''}` : ''))
  }
  if (previous && previousWeight !== undefined) {
    // Sets, not ROWS: a single-arm lift stores each prescribed set as an L and
    // an R row, so counting rows reported a three-set lift as "6×". What was
    // prescribed at the time if the entry says; else the rows progression
    // itself counts, which is the left side alone for per-side work.
    const count = previous.entry.prescribedSets ?? progressionSets(previous.entry.sets).length
    // Through the local-day helper: the date is stored at local noon and
    // serialized as UTC, so slicing the string shows the wrong calendar day
    // either side of the date line.
    const day = dateToDay(new Date(previous.workout.date)).slice(5)
    parts.push(`last ${day}: `
      + `${count}×${previous.entry.sets[0]?.reps ?? '?'} @ ${previousWeight}${unit ?? ''}`)
  }

  return (
    <div className="flex flex-col gap-0.5">
      <Inner block={block}/>
      {parts.length > 0 ? (
        <div className="text-xs tabular-nums text-muted-foreground">{parts.join(' · ')}</div>
      ) : null}
    </div>
  )
}

// No type re-check inside: the contribution already gated on `context.types`,
// which comes from the same reactive read, so the branch could never be taken
// — it only bought a second subscription on every decorated block.
export const decorateLiftContent = cachedContentDecorator(LiftSummary, 'StrengthLiftLine')
