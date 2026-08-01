/** Where a new session gets stamped.
 *
 *  Follows the gesture rather than a rule of the extension's own. Sessions
 *  used to be filed in the day's daily note on the argument that a workout is
 *  a thing you did today — but "put it where I am pointing" beats "put it
 *  where I think it belongs", and the daily note was never something the
 *  reader needs: `buildHistory` and `standingSession` both scan by TYPE across
 *  the workspace, so placement is organisation, never correctness.
 *
 *  Pure, so the rule can be tested without a repo — and so the two callers
 *  (the shortcut and the log page's button) are demonstrably deciding the
 *  same way.
 */

/** The subset of a block this decision reads. */
export interface FocusRow {
  id: string
  parentId: string | null
  content: string
  orderKey: string
  /** Whether it already holds anything. An empty block with children is a
   *  heading you are pointing at, not a slot you just opened. */
  hasChildren: boolean
  /** Its property bag, INCLUDING `types` — which is a property here, so this
   *  one field answers "does it carry a type" too. See `isExpendableLine`. */
  properties: Readonly<Record<string, unknown>>
}

/** Whether this line is the blank one you just opened with Enter — the only
 *  thing a session is allowed to take the place of, because taking a line's
 *  place DELETES it, cascading over anything under it.
 *
 *  Blank text is not enough. A block's types live in its property bag, so a
 *  blank line can be an empty todo, a property-schema definition, or any other
 *  typed record whose content is empty by design — in this workspace 1003
 *  blank blocks carry properties and 402 of those carry a type. Treating one
 *  of those as scratch space would delete a record because you happened to run
 *  a command while pointing at it.
 *
 *  So: carries nothing at all. A blank line with only view state on it
 *  (`system:collapsed`) fails this too and merely gets the session as a child,
 *  which is the harmless side of the trade.
 */
export const isExpendableLine = <
  T extends Pick<FocusRow, 'content' | 'parentId' | 'hasChildren' | 'properties'>,
>(
  row: T,
  // A guard, not a boolean: "expendable" always implies a parent to put the
  // session under, and saying so here is what lets the caller use it.
): row is T & {parentId: string} =>
  row.content.trim() === ''
  && row.parentId !== null
  && !row.hasChildren
  && Object.keys(row.properties).length === 0

export interface Placement {
  parentId: string
  /** Only `first`/`last`, deliberately. An anchored insert re-keys the
   *  siblings around it and throws outright when the anchor has moved away or
   *  been deleted — inside the stamping transaction that would abort the whole
   *  session over where it was going to sit. Exact placement is reached by
   *  MOVING afterwards, in a transaction of its own, so a placement that fails
   *  costs you a slot rather than the session; see `replaces`. */
  position: {kind: 'first'} | {kind: 'last'}
  /** An empty block the session is taking the place of.
   *
   *  Both fields are needed and both are used after the stamp: the session is
   *  moved into `orderKey` — free, because `id` is about to stop using it —
   *  and then `id` is deleted. Doing it in that order means a stamp that
   *  fails costs you nothing, and it lands the session exactly where the
   *  empty line was rather than merely on the same parent. */
  replaces?: {id: string; orderKey: string}
}

/** The log page's button: newest session at the top, because the page is
 *  read as a log. */
export const placeOnPage = (pageId: string): Placement =>
  ({parentId: pageId, position: {kind: 'first'}})

/** The shortcut: where the cursor is.
 *
 *  An EXPENDABLE focused block is the slot you just opened with Enter, so the
 *  session takes its place — appended to its parent, which is where that
 *  empty block was sitting, and the block itself goes away rather than
 *  staying on as a blank wrapper. Anything else is a block you are pointing
 *  AT, so the session becomes its child.
 *
 *  A page (no parent) is never replaced even when its title is empty —
 *  there is nowhere to put the session but inside it, and deleting a page
 *  because you ran a command on it is not a trade anyone wants.
 */
export const placeAtFocus = (focus: FocusRow): Placement =>
  isExpendableLine(focus)
    ? {
      parentId: focus.parentId,
      // Stamped at the end and moved into the slot after; `last` is the
      // smaller visible jump of the two while that happens.
      position: {kind: 'last'},
      replaces: {id: focus.id, orderKey: focus.orderKey},
    }
    : {parentId: focus.id, position: {kind: 'first'}}
