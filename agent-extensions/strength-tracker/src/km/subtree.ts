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

import {FIELD, SET_TYPE} from './fields'

export type ChildReader = (parentId: string) => Promise<readonly BlockData[]>

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
      if (hasBlockType(child, SET_TYPE) && child.properties[FIELD.todoStatus] === 'done') {
        count += 1
      }
      await walk(child.id)
    }
  }
  await walk(workoutId)
  return count
}
