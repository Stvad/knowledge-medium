import { truncate } from '@/utils/string.js'
import { BlockCrumbs } from '@/components/BlockCrumbs.js'
import { TypeChip } from '@/components/typeChip/TypeChip.js'
import type { TypeContribution } from '@/data/api'
import {
  displayableTypes,
  type DisplayableType,
  type LinkTargetBlockMatch,
} from '@/utils/linkTargetAutocomplete.js'
import { quickFindBlockValue } from './selection.ts'
import type { QuickFindListItem } from './QuickFind.tsx'

const ROW_TEXT_MAX_CHARS = 80

/** Chips shown before the rest are dropped. Two is what the line can
 *  carry without the path — the other half of the same context — losing
 *  its share of the width. No `+N` marker: it would cost a slot to say
 *  something the row can't act on anyway, and the sibling `[[` dropdown
 *  already shows only the first type. */
const MAX_ROW_TYPE_CHIPS = 2

/** What every result row needs beyond its own match: where the block
 *  lives, and the registry that turns its raw type ids into labels.
 *  Threaded from the dialog rather than read via hooks here, so these
 *  stay plain functions. */
export interface ResultRowContext {
  crumbsByBlockId: ReadonlyMap<string, readonly string[]>
  typeRegistry: ReadonlyMap<string, TypeContribution>
}

/** The row's context line: what the block is, then where it lives.
 *
 *  One line for both, left-packed. Not a second line — that would double
 *  the reserved height of every row to serve the subset that has types —
 *  and not right-aligned, which would fling a lone chip to the far edge,
 *  away from the content it describes.
 *
 *  Chips lead, and the ORDER is load-bearing rather than a reading
 *  preference. The chips are on the match itself and paint immediately;
 *  the path arrives later on a batched query. Crumbs-first therefore ties
 *  the chips' position to something that isn't there yet — they start one
 *  flex `gap` in from the line (an empty box still spaces its sibling, so
 *  a page with no path had its chip 6px adrift of the content beneath it)
 *  and then slide right by the path's width the moment it resolves.
 *  Chips-first pins them to the line's edge in every combination, and
 *  the late-arriving part is the part with nothing after it to disturb.
 *
 *  `BlockCrumbs` still renders unconditionally, and now sits last, where
 *  its reserved-but-empty box costs nothing visually.
 *
 *  Chips are `shrink-0` and the crumbs are not: when the line runs out of
 *  width the path truncates and the chips survive whole. */
/** Whether this row gets a context line at all.
 *
 *  The line is RESERVED rather than conditional because crumbs land on a
 *  later batched query, and a line that appears when they do would shove
 *  every row below it. But reserving is only worth its 16px where
 *  something can actually arrive — and for a root block nothing can:
 *  `manyAncestors` walks parents, so a block with no parent resolves to
 *  an empty chain by construction, not by chance. Those rows were
 *  holding a blank line forever, which reads as a failed load rather
 *  than as "this block has no path".
 *
 *  So the reservation follows the block's own parent edge, known at
 *  first paint. `parentId` non-null is the reserve case; note that a cut
 *  chain still yields the `…` marker, so a parented row is never blank
 *  for want of ancestors.
 *
 *  `crumbs?.length` is the fallback for a stale payload: `searchByContent`
 *  declares no row dependency, so a block re-parented since the query
 *  can arrive claiming `parentId: null` and then produce a real path.
 *  Rare, and it costs one row growing rather than a dropped path. */
const hasContextLine = (
  crumbs: readonly string[] | undefined,
  chipCount: number,
  parentId: string | null,
): boolean => chipCount > 0 || parentId !== null || (crumbs?.length ?? 0) > 0

const contextLine = (
  crumbs: readonly string[] | undefined,
  chips: readonly DisplayableType[],
) => (
  <div className="flex w-full items-center gap-1.5">
    {chips.map(({typeId, type}) => (
      // No link and no remove ✕: a click anywhere in a result row has to
      // select that row. Both affordances belong to the block's own chip
      // row, where a click means what it says.
      <TypeChip
        key={typeId}
        typeId={typeId}
        type={type}
        withHash
        className="shrink-0 py-0 leading-4"
      />
    ))}
    <BlockCrumbs crumbs={crumbs}/>
  </div>
)

/** A result row: the context line, then what the block says — or just
 *  what it says, for a block that has no context and never will (see
 *  {@link hasContextLine}).
 *
 *  The crumbs arrive from a separate batched load keyed by block id, so
 *  `crumbs` is routinely `undefined` — `BlockCrumbs` renders its reserved
 *  line either way and the row height never changes. Types need no such
 *  care: they ride along with the match itself and are there on the first
 *  paint.
 *
 *  Context-less rows drop the two-line styling entirely rather than
 *  keeping it with an empty slot, so they render at the same height as
 *  every other single-line row in the dialog (a Pages or Create row)
 *  instead of at a third height of their own.
 *
 *  `items-stretch` (over the base row's `items-center`) is what gives the
 *  two children full width, which is what makes `truncate` truncate
 *  rather than overflow. */
const resultRow = ({key, value, text, crumbs, typeIds, parentId, typeRegistry}: {
  key: string
  value: string
  text: string
  crumbs: readonly string[] | undefined
  typeIds: readonly string[]
  parentId: string | null
  typeRegistry: ReadonlyMap<string, TypeContribution>
}): QuickFindListItem => {
  const chips = displayableTypes(typeIds, typeRegistry).slice(0, MAX_ROW_TYPE_CHIPS)
  const content = <span className="w-full truncate">{truncate(text, ROW_TEXT_MAX_CHARS)}</span>
  if (!hasContextLine(crumbs, chips.length, parentId)) return {key, value, children: content}
  return {
    key,
    value,
    className: 'flex-col items-stretch gap-0.5 py-2',
    children: (
      <>
        {contextLine(crumbs, chips)}
        {content}
      </>
    ),
  }
}

/** Rows of the "Blocks" (content-match) group. */
export const blockResultItems = (
  blocks: readonly LinkTargetBlockMatch[],
  {crumbsByBlockId, typeRegistry}: ResultRowContext,
): QuickFindListItem[] =>
  blocks.map(match => resultRow({
    key: `block:${match.blockId}`,
    value: quickFindBlockValue(match),
    text: match.content,
    crumbs: crumbsByBlockId.get(match.blockId),
    typeIds: match.typeIds,
    parentId: match.parentId,
    typeRegistry,
  }))

export interface RecentResultItem {
  blockId: string
  label: string
  typeIds: readonly string[]
  parentId: string | null
}

/** Rows of the "Recent" group.
 *
 *  Crumbed for the same reason the Blocks group is, and arguably a
 *  stronger one: `pushRecentBlockId` records whatever the user navigated
 *  to, which is frequently a block partway down a page rather than the
 *  page itself — so a bare label here is exactly as unplaceable as a
 *  content match was before crumbs existed. Recents render only for an
 *  empty query, so these rows never share the list with Blocks rows and
 *  the two can't disagree about a block's path on screen at once. */
export const recentResultItems = (
  recents: readonly RecentResultItem[],
  {crumbsByBlockId, typeRegistry}: ResultRowContext,
): QuickFindListItem[] =>
  recents.map(item => resultRow({
    key: `recent:${item.blockId}`,
    value: `recent:${item.blockId}`,
    text: item.label,
    crumbs: crumbsByBlockId.get(item.blockId),
    typeIds: item.typeIds,
    parentId: item.parentId,
    typeRegistry,
  }))
