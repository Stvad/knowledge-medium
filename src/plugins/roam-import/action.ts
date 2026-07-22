import type { Repo } from '@/data/repo'
import {
  ActionConfig,
  ActionContextTypes,
} from '@/shortcuts/types.js'
import { activeWorkspaceIdPreferringHash } from '@/utils/navigation.js'
import { importRoam } from './import.ts'
import { showProgress } from '@/utils/toast.js'
import { scheduleIdle } from '@/utils/scheduleIdle.js'
import { runAnalyzeIfStale } from '@/data/maintenance'
import type { RoamExport } from './types.ts'

export const importRoamAction = ({repo}: {repo: Repo}): ActionConfig => ({
  id: 'import_roam',
  description: 'Import Roam JSON export',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = async (loadEvent) => {
        const content = loadEvent.target?.result
        if (typeof content !== 'string') return

        const banner = showProgress('Roam import: parsing JSON…')
        try {
          const parsed = JSON.parse(content) as RoamExport
          if (!Array.isArray(parsed)) {
            console.error('[roam-import] expected top-level JSON array of pages')
            banner.fail('Roam import failed: expected top-level JSON array of pages')
            return
          }

          const workspaceId = activeWorkspaceIdPreferringHash(repo)
          if (!workspaceId) {
            console.error('[roam-import] no active workspace')
            banner.fail('Roam import failed: no active workspace')
            return
          }

          banner.update('Roam import: planning…')
          const summary = await importRoam(parsed, repo, {
            workspaceId,
            currentUserId: repo.user.id,
            onProgress: msg => {
              console.log(`[roam-import] ${msg}`)
              banner.update(`Roam import: ${msg}`)
            },
          })
          console.log('[roam-import] done', summary)
          banner.done(
            `Roam import complete: ${summary.pagesCreated} new pages, ` +
            `${summary.pagesMerged} merged, ${summary.pagesDaily} daily, ` +
            `${summary.blocksWritten} blocks (${(summary.durationMs / 1000).toFixed(1)}s)`,
          )
          // A bulk import can multiply the workspace; the planner's
          // `sqlite_stat1` is now stale and would mis-rank join orders
          // until the next boot. Re-check drift at idle so good plans land
          // this session without a reload (no-op unless the import grew
          // `blocks` past the drift factor — see clientSchema.runAnalyzeIfStale).
          scheduleIdle(() => {
            void runAnalyzeIfStale(repo.db).catch(error => {
              console.warn('[roam-import] ANALYZE check failed:', error)
            })
          })
        } catch (err) {
          console.error('[roam-import] failed:', err)
          banner.fail(`Roam import failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      reader.readAsText(file)
    }

    input.click()
  },
})
