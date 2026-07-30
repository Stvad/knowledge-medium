import type { Repo } from '@/data/repo'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { runAnalyzeNow } from '@/data/maintenance'
import { showProgress } from '@/utils/toast.js'
import { DatabaseZap } from 'lucide-react'

/** Command-palette command that runs SQLite `ANALYZE` on demand,
 *  unconditionally.
 *
 *  The data layer re-analyzes on its own when either staleness axis moves —
 *  `blocks` row-count drift, or a change to the index set / which indexes have
 *  stats (see clientSchema.runAnalyzeIfStale) — so this is the manual escape
 *  hatch for the cases neither axis models: stats that are present and
 *  schema-current but wrong for the current query mix.
 *
 *  ANALYZE is a multi-second scan on a large DB that holds the single SQLite
 *  worker, so it is deliberately NOT wired to anything automatic here — the
 *  user asked, so always run. */
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
