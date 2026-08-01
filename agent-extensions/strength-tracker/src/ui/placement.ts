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
}

export interface Placement {
  parentId: string
  /** Only `first`/`last`: `getOrCreateTypedChild` refuses an anchored
   *  position so that "is this position supported" answers the same whether
   *  or not a record already sits at the derived id — a determinism the
   *  untyped callers (dynamic extensions, bridge `eval`) depend on. Exact
   *  placement is reached by MOVING afterwards instead; see `replaces`. */
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
 *  An EMPTY focused block is the slot you just opened with Enter, so the
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
  focus.content.trim() === '' && focus.parentId !== null && !focus.hasChildren
    ? {
      parentId: focus.parentId,
      // Stamped at the end and moved into the slot after; `last` is the
      // smaller visible jump of the two while that happens.
      position: {kind: 'last'},
      replaces: {id: focus.id, orderKey: focus.orderKey},
    }
    : {parentId: focus.id, position: {kind: 'first'}}
