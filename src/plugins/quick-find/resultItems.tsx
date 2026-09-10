import { truncate } from '@/utils/string.js'
import { BlockCrumbs } from '@/components/BlockCrumbs.js'
import { TypeChip } from '@/components/typeChip/TypeChip.js'
import type { TypeContribution } from '@/data/api'
import {
  displayableTypes,
  type LinkTargetAliasMatch,
  type LinkTargetBlockMatch,
} from '@/utils/linkTargetAutocomplete.js'
import { quickFindAliasValue, quickFindBlockValue } from './selection.ts'
import type { RecentItem } from './recents.ts'
import type { QuickFindListItem } from './QuickFind.tsx'

const ROW_TEXT_MAX_CHARS = 80

/** Chips shown before the rest are dropped. Two is what the text line
 *  can carry without the content — the thing the row is actually about —
 *  losing its share of the width. No `+N` marker: it would cost a slot
 *  to say something the row can't act on anyway, and the sibling `[[`
 *  dropdown already shows only the first type. */
const MAX_ROW_TYPE_CHIPS = 2

/** What every result row needs beyond its own match: where the block
 *  lives, and the registry that turns its raw type ids into labels.
 *  Threaded from the dialog rather than read via hooks here, so these
 *  stay plain functions. */
export interface ResultRowContext {
  crumbsByBlockId: ReadonlyMap<string, readonly string[]>
  typeRegistry: ReadonlyMap<string, TypeContribution>
}

/** Whether this row gets a crumb line.
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
 *  Both inputs are settled at first paint, which is the property that
 *  matters: `parentId` rides on the match and never changes for a given
 *  row, and `crumbs?.length` only ever goes from absent to present.
 *  TYPES deliberately do not appear here — they render on the text line
 *  instead (see {@link resultRow}), because their visibility depends on
 *  a live registry and anything live in this gate can move the row after
 *  paint.
 *
 *  `crumbs?.length` is also the stale-payload fallback: `searchByContent`
 *  declares no row dependency, so a block re-parented since the query can
 *  arrive claiming `parentId: null` and then produce a real path. Costs
 *  one row growing rather than a dropped path. */
const hasCrumbLine = (
  crumbs: readonly string[] | undefined,
  parentId: string | null,
): boolean => parentId !== null || (crumbs?.length ?? 0) > 0

/** The row's text, with the block's types trailing it.
 *
 *  Types live HERE rather than on the crumb line for one structural
 *  reason: this line always exists, and its height comes from the text
 *  (20px), which already clears a chip (16px). So chips can appear when
 *  the registry learns their names, or vanish when a definition is
 *  edited, without changing the row's height — no reservation to get
 *  right, and the registry stops being a layout input at all. It also
 *  matches how a block renders its own types (`TypeChipsDecorator`
 *  hangs them off the end of the content) and how this dialog's other
 *  rows carry secondary detail, right-aligned (Pages, Date).
 *
 *  The text takes the slack and the chips do not, so a long line
 *  truncates and the chips stay whole and column-aligned down the list.
 *  `max-w-[30%]` caps that priority — type labels are user-authored and
 *  unbounded, and one 55-character label measured 348px of a 478px line.
 *  `TypeChip`'s own `truncate` ellipsises what the cap clips. */
const textLine = (text: string, chips: readonly {typeId: string; type: TypeContribution}[]) => (
  <div className="flex w-full items-center gap-2">
    <span className="min-w-0 flex-1 truncate">{truncate(text, ROW_TEXT_MAX_CHARS)}</span>
    {chips.map(({typeId, type}) => (
      // No link and no remove x: a click anywhere in a result row has to
      // select that row. Both affordances belong to the block's own chip
      // row, where a click means what it says.
      <TypeChip
        key={typeId}
        typeId={typeId}
        type={type}
        withHash
        className="max-w-[30%] shrink-0 py-0 leading-4"
      />
    ))}
  </div>
)

/** A result row: the crumb line, then the text — or just the text, for a
 *  block whose path can never arrive (see {@link hasCrumbLine}).
 *
 *  The crumbs come from a separate batched load keyed by block id, so
 *  `crumbs` is routinely `undefined` — `BlockCrumbs` renders its reserved
 *  line either way, so the fill-in is a repaint rather than a reflow.
 *
 *  Rows with no crumb line drop the two-line styling entirely rather than
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
} & Pick<ResultRowContext, 'typeRegistry'>): QuickFindListItem => {
  const chips = displayableTypes(typeIds, typeRegistry).slice(0, MAX_ROW_TYPE_CHIPS)
  const line = textLine(text, chips)
  if (!hasCrumbLine(crumbs, parentId)) return {key, value, children: line}
  return {
    key,
    value,
    className: 'flex-col items-stretch gap-0.5 py-2',
    children: (
      <>
        <BlockCrumbs crumbs={crumbs}/>
        {line}
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
  recents: readonly RecentItem[],
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

/** Rows of the "Pages" (alias-match) group.
 *
 *  Single-line: the page's name is its own locator, so there is no path
 *  to show. But its TYPES belong here as much as anywhere — arguably
 *  more, since this is the group you land in when you search a page BY
 *  NAME, which is exactly when `#person` vs `#project` is the thing
 *  telling two similar names apart. Without them a page showed its tags
 *  in Recents and lost them the moment you typed its name.
 *
 *  Chips trail the row, past the content preview, so they line up with
 *  the chips on every other group's rows. They arrive on the second
 *  search callback (see `LinkTargetAliasMatch.typeIds`) and cost this
 *  row no reflow when they do: its height is the text's. */
export const aliasResultItems = (
  aliases: readonly LinkTargetAliasMatch[],
  {typeRegistry}: ResultRowContext,
): QuickFindListItem[] =>
  aliases.map(match => ({
    key: `page:${match.blockId}:${match.alias}`,
    value: quickFindAliasValue(match),
    className: 'flex items-center gap-2',
    children: (
      <>
        {/* `min-w-24`, not `min-w-0`: `flex-1` is `flex: 1 1 0%`, a ZERO
            basis, so the name has no width of its own and lives entirely
            on what the other children leave behind. Uniquely on this row
            they can leave nothing — a preview at 40% plus two capped
            chips at 30% each is the whole line, and the page NAME
            measured 0px wide, which is the one thing the row exists to
            show. (Blocks and Recents rows carry no preview, so their two
            chips are bounded at 60% and their text always keeps the
            rest.) The floor is what the name is guaranteed; `truncate`
            still fires because the floor is far below its content. */}
        <span className="min-w-24 flex-1 truncate">{match.alias}</span>
        {match.content && match.content !== match.alias && (
          <span className="min-w-0 max-w-[30%] shrink truncate text-xs text-muted-foreground">
            {truncate(match.content, 50)}
          </span>
        )}
        {displayableTypes(match.typeIds, typeRegistry)
          .slice(0, MAX_ROW_TYPE_CHIPS)
          .map(({typeId, type}) => (
            // 25% rather than the 30% the other groups use: this row has
            // four things competing for one line instead of two.
            <TypeChip
              key={typeId}
              typeId={typeId}
              type={type}
              withHash
              className="max-w-[25%] shrink-0 py-0 leading-4"
            />
          ))}
      </>
    ),
  }))
