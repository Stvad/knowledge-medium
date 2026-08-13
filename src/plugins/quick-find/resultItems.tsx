import { truncate } from '@/utils/string.js'
import { BlockCrumbs } from '@/components/BlockCrumbs.js'
import { TypeChip } from '@/components/typeChip/TypeChip.js'
import type { TypeContribution } from '@/data/api'
import {
  displayableTypes,
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

/** The row's context line: where the block lives, then what it is.
 *
 *  One line for both, left-packed. A block with no path (a page) gets its
 *  chips at the left, which is precisely the space its empty crumb line
 *  was already reserving; a block with both reads
 *  `Tutorial › Welcome #book`. Not a second line — that would double the
 *  reserved height of every row to serve the subset that has types — and
 *  not right-aligned, which would fling a lone chip to the far edge,
 *  away from the content it describes.
 *
 *  Chips are `shrink-0` and the crumbs are not: when the line runs out of
 *  width the path truncates and the chips survive whole. */
const contextLine = (
  crumbs: readonly string[] | undefined,
  typeIds: readonly string[],
  typeRegistry: ReadonlyMap<string, TypeContribution>,
) => (
  <div className="flex w-full items-center gap-1.5">
    <BlockCrumbs crumbs={crumbs}/>
    {displayableTypes(typeIds, typeRegistry).slice(0, MAX_ROW_TYPE_CHIPS).map(({typeId, type}) => (
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
  </div>
)

/** A two-line result row: the context line, then what the block says.
 *
 *  The crumbs arrive from a separate batched load keyed by block id, so
 *  `crumbs` is routinely `undefined` — `BlockCrumbs` renders its reserved
 *  line either way and the row height never changes. Types need no such
 *  care: they ride along with the match itself and are there on the first
 *  paint.
 *
 *  `items-stretch` (over the base row's `items-center`) is what gives the
 *  two children full width, which is what makes `truncate` truncate
 *  rather than overflow. */
const resultRow = ({key, value, text, crumbs, typeIds, typeRegistry}: {
  key: string
  value: string
  text: string
  crumbs: readonly string[] | undefined
  typeIds: readonly string[]
  typeRegistry: ReadonlyMap<string, TypeContribution>
}): QuickFindListItem => ({
  key,
  value,
  className: 'flex-col items-stretch gap-0.5 py-2',
  children: (
    <>
      {contextLine(crumbs, typeIds, typeRegistry)}
      <span className="w-full truncate">{truncate(text, ROW_TEXT_MAX_CHARS)}</span>
    </>
  ),
})

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
    typeRegistry,
  }))

export interface RecentResultItem {
  blockId: string
  label: string
  typeIds: readonly string[]
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
    typeRegistry,
  }))
