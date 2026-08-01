/** One subtree walk, readable from outside a transaction and from inside one.
 *
 *  Discard asks "what would this destroy?" twice — once to decide whether to
 *  warn, and again inside the delete to check the answer still holds. Two
 *  implementations of that question is how the warning ends up describing a
 *  tree the delete no longer applies to, so there is one, parameterised by
 *  where its children come from.
 */

import type {BlockData} from '@/data/api/index.js'
import {hasBlockType} from '@/data/properties.js'

import {EXERCISE_ENTRY_TYPE, FIELD, SET_TYPE, WORKOUT_TYPE} from './fields'

export type ChildReader = (parentId: string) => Promise<readonly BlockData[]>

/** Every workout filed underneath another one.
 *
 *  Reachable by design, not by accident: run the shortcut while pointing at
 *  last week's unfinished session and the placement contract makes tonight's a
 *  CHILD of it. The finish scan already treats one as a record boundary; this
 *  is the other side of that — what a cascading delete would take with it.
 */
export const nestedWorkouts = async (
  children: ChildReader,
  workoutId: string,
): Promise<BlockData[]> => {
  const found: BlockData[] = []
  const seen = new Set<string>([workoutId])
  const walk = async (parentId: string): Promise<void> => {
    for (const child of await children(parentId)) {
      if (child.deleted || seen.has(child.id)) continue
      seen.add(child.id)
      // Not descended into: whatever is under another workout belongs to THAT
      // record, and one hit is all a refusal needs.
      if (hasBlockType(child, WORKOUT_TYPE)) { found.push(child); continue }
      await walk(child.id)
    }
  }
  await walk(workoutId)
  return found
}

/** What discarding a workout would destroy, in the two kinds that matter. */
export interface DiscardTally {
  /** Done sets anywhere underneath, however they have been rearranged.
   *
   *  Deliberately NOT the canonical-shape walk the finish uses: this answers
   *  "would discarding destroy logged work", and a set indented under a note is
   *  still work you did — it just cannot be recorded where it sits. Counting
   *  only the canonical positions would skip the warning for exactly the tree
   *  Finish refuses, and delete it unannounced. */
  logged: number
  /** Live blocks underneath that this extension did not stamp — a note you
   *  typed under a lift, an image, anything dragged in.
   *
   *  Counted because `deleteBlock` CASCADES: everything under the workout goes,
   *  not just the prescribed skeleton, and a warning that names only logged
   *  sets describes a smaller deletion than the one on offer. The shape that
   *  hurt was a session with nothing ticked and a paragraph about why —
   *  `logged` is zero, which is the reading that shows no dialog at all, so the
   *  paragraph went silently.
   *
   *  Zero for a freshly stamped session, so escaping a start you did not mean
   *  still takes one tap and no dialog. */
  yours: number
}

export const discardTally = async (
  children: ChildReader,
  workoutId: string,
): Promise<DiscardTally> => {
  const seen = new Set<string>([workoutId])
  const tally: DiscardTally = {logged: 0, yours: 0}
  const walk = async (parentId: string): Promise<void> => {
    for (const child of await children(parentId)) {
      if (child.deleted || seen.has(child.id)) continue
      seen.add(child.id)
      // Another workout's contents are its own, not this one's — counting them
      // would describe a deletion that is refused rather than performed. See
      // `nestedWorkouts`, which is what refuses it.
      if (hasBlockType(child, WORKOUT_TYPE)) continue
      if (hasBlockType(child, SET_TYPE)) {
        if (child.properties[FIELD.todoStatus] === 'done') tally.logged += 1
      } else if (!hasBlockType(child, EXERCISE_ENTRY_TYPE)) {
        tally.yours += 1
      }
      await walk(child.id)
    }
  }
  await walk(workoutId)
  return tally
}
