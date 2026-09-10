import type { Repo } from '@/data/repo'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { runAnalyzeNow } from '@/data/maintenance'
import { showProgress } from '@/utils/toast.js'
import { DatabaseZap } from 'lucide-react'

/** Command-palette command that runs SQLite `ANALYZE` on demand,
 *  unconditionally.
 *
 *  The data layer re-analyzes on its own whenever SQLite reports stats as stale
 *  (see clientSchema.runAnalyzeIfStale), so this is the manual escape hatch for
 *  the case that heuristic cannot model: stats that are present and
 *  schema-current but wrong for the current query mix.
 *
 *  No drift gate — the user asked, so always run. ANALYZE is a multi-second
 *  scan holding the single SQLite worker, which is why the handler wraps it in
 *  a `showProgress` toast rather than running it silently. */
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
