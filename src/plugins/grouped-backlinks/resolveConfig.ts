import type { Repo } from '@/data/repo'
import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import {
  EMPTY_GROUPED_BACKLINKS_CONFIG,
  groupedBacklinksDefaultsProp,
  groupedBacklinksPrefsType,
  mergeGroupedBacklinksConfig,
  normalizeGroupedBacklinksConfig,
  selectGroupedBacklinksOverrides,
  type GroupedBacklinksConfig,
} from './config.ts'

/** How the grouped-backlinks query's grouping config should be resolved
 *  for a non-React caller (the agent bridge). Mirrors the choices the UI
 *  offers:
 *   - `'user'` (default): the user's real config — prefs defaults merged
 *     with the target block's per-block overrides. Matches what the
 *     grouped-references panel shows in-app.
 *   - `'none'`: an empty config (no priority/exclusion tuning). Useful
 *     for seeing the raw, untuned grouping — but note generic
 *     `Page`/field groups dominate, so it can be misleading.
 *   - an explicit (partial) config object: used verbatim. */
export type GroupedBacklinksGroupingSpec =
  | 'user'
  | 'none'
  | Partial<GroupedBacklinksConfig>

/** Resolve the grouping config for `blockId` the way the grouped-backlinks
 *  view does, but outside React. The `'user'` branch bootstraps the
 *  grouped-backlinks user-prefs sub-block on first access (same as
 *  opening the panel in-app does). */
export const resolveGroupedBacklinksConfig = async (
  repo: Repo,
  workspaceId: string,
  blockId: string,
  spec: GroupedBacklinksGroupingSpec | undefined = 'user',
): Promise<GroupedBacklinksConfig> => {
  if (spec && typeof spec === 'object') {
    return normalizeGroupedBacklinksConfig(spec)
  }
  if (spec === 'none') return EMPTY_GROUPED_BACKLINKS_CONFIG

  const prefsBlock = await getPluginPrefsBlock(
    repo,
    workspaceId,
    repo.user,
    groupedBacklinksPrefsType,
  )
  const defaults = prefsBlock.peekProperty(groupedBacklinksDefaultsProp)
    ?? groupedBacklinksDefaultsProp.defaultValue
  const blockData = await repo.load(blockId)
  const overrides = selectGroupedBacklinksOverrides(blockData)
  return mergeGroupedBacklinksConfig(defaults, overrides)
}
