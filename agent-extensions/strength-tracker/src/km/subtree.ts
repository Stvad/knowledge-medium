/** One subtree walk, readable from outside a transaction and from inside one.
 *
 *  Discard asks "is there logged work here?" twice — once to decide whether to
 *  warn, and again inside the delete to check the answer still holds. Two
 *  implementations of that question is how the warning ends up describing a
 *  tree the delete no longer applies to, so there is one, parameterised by
 *  where its children come from.
 */

import type {BlockData} from '@/data/api/index.js'
import {hasBlockType} from '@/data/properties.js'

import {FIELD, SET_TYPE, WORKOUT_TYPE} from './fields'

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

/** Done sets anywhere under a workout, however they have been rearranged.
 *
 *  Deliberately NOT the canonical-shape walk the finish uses: this answers
 *  "would discarding destroy logged work", and a set indented under a note is
 *  still work you did — it just cannot be recorded where it sits. Counting
 *  only the canonical positions would skip the warning for exactly the tree
 *  Finish refuses, and delete it unannounced.
 */
export const countLoggedSets = async (
  children: ChildReader,
  workoutId: string,
): Promise<number> => {
  const seen = new Set<string>([workoutId])
  let count = 0
  const walk = async (parentId: string): Promise<void> => {
    for (const child of await children(parentId)) {
      if (child.deleted || seen.has(child.id)) continue
      seen.add(child.id)
      // Another workout's sets are its own, not this one's — counting them
      // would describe a deletion that is refused rather than performed. See
      // `nestedWorkouts`, which is what refuses it.
      if (hasBlockType(child, WORKOUT_TYPE)) continue
      if (hasBlockType(child, SET_TYPE) && child.properties[FIELD.todoStatus] === 'done') {
        count += 1
      }
      await walk(child.id)
    }
  }
  await walk(workoutId)
  return count
}
