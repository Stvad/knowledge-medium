import { truncate } from '@/utils/string.js'
import { BlockCrumbs } from '@/components/BlockCrumbs.js'
import type { LinkTargetBlockMatch } from '@/utils/linkTargetAutocomplete.js'
import { quickFindBlockValue } from './selection.ts'
import type { QuickFindListItem } from './QuickFind.tsx'

const ROW_TEXT_MAX_CHARS = 80

/** A two-line result row: where the block lives, then what it says.
 *
 *  The crumbs arrive from a separate batched load keyed by block id, so
 *  `crumbs` is routinely `undefined` — `BlockCrumbs` renders its reserved
 *  line either way and the row height never changes.
 *
 *  `items-stretch` (over the base row's `items-center`) is what gives the
 *  two children full width, which is what makes `truncate` truncate
 *  rather than overflow. */
const crumbedRow = ({key, value, text, crumbs}: {
  key: string
  value: string
  text: string
  crumbs: readonly string[] | undefined
}): QuickFindListItem => ({
  key,
  value,
  className: 'flex-col items-stretch gap-0.5 py-2',
  children: (
    <>
      <BlockCrumbs crumbs={crumbs}/>
      <span className="w-full truncate">{truncate(text, ROW_TEXT_MAX_CHARS)}</span>
    </>
  ),
})

/** Rows of the "Blocks" (content-match) group. */
export const blockResultItems = (
  blocks: readonly LinkTargetBlockMatch[],
  crumbsByBlockId: ReadonlyMap<string, readonly string[]>,
): QuickFindListItem[] =>
  blocks.map(match => crumbedRow({
    key: `block:${match.blockId}`,
    value: quickFindBlockValue(match),
    text: match.content,
    crumbs: crumbsByBlockId.get(match.blockId),
  }))

export interface RecentResultItem {
  blockId: string
  label: string
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
  crumbsByBlockId: ReadonlyMap<string, readonly string[]>,
): QuickFindListItem[] =>
  recents.map(item => crumbedRow({
    key: `recent:${item.blockId}`,
    value: `recent:${item.blockId}`,
    text: item.label,
    crumbs: crumbsByBlockId.get(item.blockId),
  }))
