import { truncate } from '@/utils/string.js'
import { BlockCrumbs } from '@/components/BlockCrumbs.js'
import type { LinkTargetBlockMatch } from '@/utils/linkTargetAutocomplete.js'
import { quickFindBlockValue } from './selection.ts'
import type { QuickFindListItem } from './QuickFind.tsx'

const BLOCK_CONTENT_MAX_CHARS = 80

/** Rows of the "Blocks" (content-match) group.
 *
 *  Two lines: where the block lives, then what matched. The crumbs come
 *  from a separate batched load keyed by block id, so `crumbsByBlockId`
 *  is routinely missing entries — `BlockCrumbs` renders its reserved line
 *  either way and the row height never changes.
 *
 *  `items-stretch` (over the base row's `items-center`) is what gives the
 *  two children full width, which is what makes `truncate` truncate
 *  rather than overflow. */
export const blockResultItems = (
  blocks: readonly LinkTargetBlockMatch[],
  crumbsByBlockId: ReadonlyMap<string, readonly string[]>,
): QuickFindListItem[] =>
  blocks.map(match => ({
    key: `block:${match.blockId}`,
    value: quickFindBlockValue(match),
    className: 'flex-col items-stretch gap-0.5 py-2',
    children: (
      <>
        <BlockCrumbs crumbs={crumbsByBlockId.get(match.blockId)}/>
        <span className="w-full truncate">
          {truncate(match.content, BLOCK_CONTENT_MAX_CHARS)}
        </span>
      </>
    ),
  }))
