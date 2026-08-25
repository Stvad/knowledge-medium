import type { Repo } from '@/data/repo'
import {
  ActionConfig,
  ActionContextTypes,
} from '@/shortcuts/types.js'
import { activeWorkspaceIdPreferringHash } from '@/utils/navigation.js'
import { importRoam } from './import.ts'
import { showProgress } from '@/utils/toast.js'
import { CATCHUP_DEEP_IDLE, scheduleDeepIdle } from '@/utils/scheduleIdle.js'
import { runAnalyzeIfStale } from '@/data/maintenance'
import { resolveAnalyzeArmingProbes } from '@/data/localSchema.js'
import { localSchemaFacet } from '@/data/facets.js'
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
          // `sqlite_stat1` is now stale and would mis-rank join orders until
          // the next boot. Re-check at idle so good plans land this session
          // without a reload. Usually a no-op — it re-analyzes only what SQLite
          // reports as stale (see clientSchema.runAnalyzeIfStale), which for a
          // table that merely grew means ~10x growth.
          //
          // Deep idle, matching the boot check in repoProvider: ANALYZE is a
          // multi-second park of the single SQLite worker, and scheduleIdle's
          // 2s cap would land it right as the freshly-imported tree renders.
          // Fire-and-forget: if this one no-ops, the next boot's check covers it.
          //
          // Probes off the repo's FacetRuntime, not the core default: an import
          // grows the reference edges as much as it grows `blocks`, and
          // `block_references` is armed only by the references plugin's own
          // contribution.
          scheduleDeepIdle(() => {
            const probes = resolveAnalyzeArmingProbes(
              repo.facetRuntime?.read(localSchemaFacet) ?? [],
            )
            void runAnalyzeIfStale(repo.db, probes).catch(error => {
              console.warn('[roam-import] ANALYZE check failed:', error)
            })
          }, CATCHUP_DEEP_IDLE)
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
