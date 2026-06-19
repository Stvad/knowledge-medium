import type { Repo } from '@/data/repo'
import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import {
  backlinksPrefsType,
  dailyNoteBacklinksDefaultsProp,
  effectiveBacklinksFilterForBlock,
} from './dailyNoteDefaults.ts'
import { backlinksFilterProp, readBacklinksFilterProperty } from './filterProperty.ts'
import {
  hasBacklinksFilter,
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

/** How to resolve the backlinks filter for a non-React caller (the agent
 *  bridge). The agent picks one of:
 *   - `'none'` (default): no filter — every backlink.
 *   - `'stored'`: the target block's own saved filter
 *     (`backlinks:predicates`), ignoring daily-note defaults.
 *   - `'effective'`: what the UI actually applies — for a daily note,
 *     the daily-note default filter merged with the block's own filter;
 *     for any other block, just the block's own filter.
 *   - an explicit `BacklinksFilter` object: used verbatim. */
export type BacklinksFilterSpec = 'none' | 'stored' | 'effective' | BacklinksFilter

/** Resolve a `BacklinksFilter` (or `undefined` for "no filter") for
 *  `blockId`. Returns `undefined` whenever the resolved filter is empty
 *  so callers can skip passing it to the query. The `'effective'` branch
 *  bootstraps the backlinks user-prefs sub-block (same as the panel). */
export const resolveBacklinksFilter = async (
  repo: Repo,
  workspaceId: string,
  blockId: string,
  spec: BacklinksFilterSpec | undefined = 'none',
): Promise<BacklinksFilter | undefined> => {
  if (spec && typeof spec === 'object') {
    const normalized = normalizeBacklinksFilter(spec)
    return hasBacklinksFilter(normalized) ? normalized : undefined
  }
  if (spec === 'none') return undefined

  const blockData = await repo.load(blockId)
  const stored = readBacklinksFilterProperty(blockData?.properties?.[backlinksFilterProp.name])
  if (spec === 'stored') {
    return hasBacklinksFilter(stored) ? stored : undefined
  }

  // 'effective': mirror useBacklinkFilterState — merge the daily-note
  // defaults (only applied when the block is a daily note) with the
  // block's own stored filter.
  const prefsBlock = await getPluginPrefsBlock(repo, workspaceId, repo.user, backlinksPrefsType)
  const dailyNoteDefaults = prefsBlock.peekProperty(dailyNoteBacklinksDefaultsProp)
    ?? dailyNoteBacklinksDefaultsProp.defaultValue
  const effective = effectiveBacklinksFilterForBlock(blockData, stored, dailyNoteDefaults)
  return hasBacklinksFilter(effective) ? effective : undefined
}
