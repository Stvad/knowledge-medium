/**
 * Database-maintenance plugin.
 *
 * Contributes a single global command — `rebuild_query_stats` — that runs
 * SQLite `ANALYZE` on demand. The data layer re-analyzes automatically
 * when `blocks` drifts from the recorded planner stats (see
 * `clientSchema.runAnalyzeIfStale`); this command is the manual override
 * for a user already hitting query freezes.
 */
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/extensions/facet.js'
import { actionsFacet } from '@/extensions/core.js'
import { systemToggle } from '@/extensions/togglable.js'
import { rebuildQueryStatsAction } from './action.ts'

export const dbMaintenancePlugin = ({repo}: {repo: Repo}): AppExtension =>
  systemToggle({
    id: 'system:db-maintenance',
    name: 'Database maintenance',
    description: 'Adds a command to rebuild SQLite query statistics (ANALYZE) on demand.',
  }).of([
    actionsFacet.of(rebuildQueryStatsAction({repo}), {source: 'db-maintenance'}),
  ])
