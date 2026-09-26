/** Where a new experiment block lands when the gesture is "start an
 *  experiment here" — the protocol lives in the user's notes, so this reads
 *  the focused block the same way the Strength Tracker's `ui/placement.ts`
 *  does (copied from there, `isExpendableLine` verbatim).
 *
 *  Simplified from that original: its `replaces` field takes an emptied
 *  focused line's exact slot by MOVING the new record into the line's
 *  `orderKey` and then deleting the line, inside a follow-up `repo.tx` —
 *  see that module's `takePlaceOf`. Reimplementing that here would need a
 *  `Repo`/`Tx` this pure module does not have, and `createExperimentAt`'s
 *  `ExperimentPlacement` accepts only `{parentId, position: 'first'|'last'}`
 *  — no anchor to replace. So an empty focused line is left in place and the
 *  experiment is filed as the LAST child of the line's PARENT instead of
 *  taking its slot; anything else becomes the focused block's first child.
 *
 *  Pure, so the rule is testable without a repo — and so the lab page's
 *  button and the "start an experiment here" action are demonstrably
 *  deciding the same way.
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
 *  kind of line an experiment is filed BESIDE rather than under.
 *
 *  Blank text is not enough: types live in the property bag, so a blank line
 *  can be an empty todo or a property-schema definition. So: carries nothing
 *  at all. A line with only view state fails this too and merely gets the
 *  experiment as a child, which is the harmless side of the trade. */
export const isExpendableLine = <
  T extends Pick<FocusRow, 'content' | 'parentId' | 'hasChildren' | 'properties'>,
>(
  row: T,
  // A guard, not a boolean: "expendable" always implies a parent to file the
  // experiment under, and saying so here is what lets the caller use it.
): row is T & {parentId: string} =>
  row.content.trim() === ''
  && row.parentId !== null
  && !row.hasChildren
  && Object.keys(row.properties).length === 0

export interface Placement {
  parentId: string
  /** Only `first`/`last` — see `ExperimentPlacement` in `../km/experiment`,
   *  which this must match exactly. */
  position: {kind: 'first'} | {kind: 'last'}
}

/** The Sleep Lab page's button: newest experiment at the top, same as
 *  `createExperiment`'s own placement. */
export const placeOnPage = (pageId: string): Placement =>
  ({parentId: pageId, position: {kind: 'first'}})

/** "Start an experiment here": where the cursor is.
 *
 *  An EXPENDABLE focused block is the slot you just opened with Enter, so
 *  the experiment is filed as the last child of ITS PARENT — beside it,
 *  leaving the blank line as it was (see the module doc for why this stops
 *  short of taking the line's place). Anything else is a block you are
 *  pointing AT, so the experiment becomes its child. A page (no parent) is
 *  never treated as expendable even when untitled — there is nowhere to put
 *  the experiment but inside it. */
export const placeAtFocus = (focus: FocusRow): Placement =>
  isExpendableLine(focus)
    ? {parentId: focus.parentId, position: {kind: 'last'}}
    : {parentId: focus.id, position: {kind: 'first'}}
