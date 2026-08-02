/** "Due" as daily notes define it. Both halves of this file exist because
 *  the boundary between "today or earlier" and "later" is a property of how
 *  daily notes ENCODE dates, not of whatever plugin happens to be asking —
 *  so re-deriving it per caller is how a subtle timezone bug gets shipped
 *  twice. SRS review and the Readwise review backlog both build on it.
 */
import { dailyNoteDateProp } from './schema.ts'

/** UTC midnight of the day after today's *local* calendar date. Something is
 *  due when its daily note's date is strictly before this — i.e. today or any
 *  earlier day.
 *
 *  Daily notes store `daily-note:date` at UTC midnight of their calendar day
 *  (`Date.parse(`${iso}T00:00:00Z`)`), so the cutoff has to be UTC midnight
 *  too. A local-midnight cutoff would, west of UTC, encode to later than
 *  tomorrow's UTC-midnight daily note and pull tomorrow's items in a day
 *  early. */
export const dueBoundary = (now: Date = new Date()): Date => {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  tomorrow.setDate(tomorrow.getDate() + 1)
  return new Date(Date.UTC(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()))
}

/** A `where` fragment for `core.typedBlocks`: the block's `refPropertyName`
 *  ref points at a daily note dated today or earlier.
 *
 *  Uses the query language's `target` operator to traverse the ref into the
 *  daily note and compare the note's own date, so callers never have to
 *  resolve daily-note ids themselves. `refPropertyName` must be a `ref` /
 *  `refList` property whose `targetTypes` include the daily note. */
export const dueByDailyNoteRef = (
  refPropertyName: string,
  now?: Date,
): Readonly<Record<string, unknown>> => ({
  [refPropertyName]: {
    target: {[dailyNoteDateProp.name]: {lt: dueBoundary(now)}},
  },
})
