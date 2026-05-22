import type { Repo } from '@/data/repo'
import {
  ActionConfig,
  ActionContextTypes,
} from '@/shortcuts/types.js'
import { parseAppHash } from '@/utils/routing.js'
import { importRoam } from './import.ts'
import { showProgress } from '@/utils/toast.js'
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

          // Prefer the URL hash over `repo.activeWorkspaceId` —
          // the hash is the source of truth for what workspace
          // the user is viewing, and `repo.activeWorkspaceId`
          // can lag behind it (the active id flips inside
          // App.tsx's async getInitialBlock chain, which awaits
          // workspace lookup + role check before settling).
          // If the user clicks the import shortcut shortly after
          // switching workspaces, reading repo state alone would
          // route the import into the prior workspace.
          const workspaceId = parseAppHash(window.location.hash).workspaceId
            ?? repo.activeWorkspaceId
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
