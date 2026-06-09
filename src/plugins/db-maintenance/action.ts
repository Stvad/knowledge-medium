import type { Repo } from '@/data/repo'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { runAnalyzeNow } from '@/data/internals/clientSchema.js'
import { showProgress } from '@/utils/toast.js'
import { DatabaseZap } from 'lucide-react'

/** Command-palette command that runs SQLite `ANALYZE` on demand,
 *  repopulating `sqlite_stat1` so the query planner stops mis-ranking
 *  join orders on a large `blocks` table.
 *
 *  The app normally re-analyzes itself when the table drifts from the
 *  recorded stats (boot / first-sync / post-import — see
 *  `clientSchema.runAnalyzeIfStale`), so this is the manual escape hatch:
 *  a user hitting query freezes can force it without waiting for a
 *  trigger. Unlike the automatic path it bypasses the drift gate
 *  (`runAnalyzeNow`) — the user asked, so always run.
 *
 *  ANALYZE is a multi-second scan on a large DB that holds the single
 *  SQLite worker, so the handler surfaces a progress toast rather than
 *  running silently. */
export const rebuildQueryStatsAction = ({repo}: {repo: Repo}): ActionConfig => ({
  id: 'rebuild_query_stats',
  description: 'Rebuild query statistics (ANALYZE)',
  context: ActionContextTypes.GLOBAL,
  icon: DatabaseZap,
  handler: async () => {
    const banner = showProgress('Rebuilding query statistics…')
    try {
      const {count} = await runAnalyzeNow(repo.db)
      banner.done(`Query statistics rebuilt over ${count.toLocaleString()} blocks.`)
    } catch (err) {
      console.error('[db-maintenance] ANALYZE failed:', err)
      banner.fail(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
})
