// Idempotent window-hook so the agent runtime / devtools console can
// kick off an import without going through the file-picker UI.
//
// Usage from the agent runtime (pnpm agent eval):
//   const json = JSON.parse(await (await fetch('/tmp/roam.json')).text())
//   return await window.__omniliner.roamImport.run(json)

import { Repo } from '@/data/repo'
import { omnilinerNamespace } from '@/utils/omnilinerNamespace'
import { importRoam, type RoamImportOptions, type RoamImportSummary } from './import'
import { planImport } from './plan'
import type { RoamExport } from './types'

interface RoamImportWindowAPI {
  /**
   * Run the import against the active workspace. workspaceId and
   * currentUserId default to repo.activeWorkspaceId / repo.user.id;
   * pass overrides if you want to import elsewhere.
   */
  run: (pages: RoamExport, options?: Partial<RoamImportOptions>) => Promise<RoamImportSummary>
  /** Run the planner alone — useful for inspecting what would be written. */
  plan: typeof planImport
}

declare module '@/utils/omnilinerNamespace' {
  interface OmnilinerNamespace {
    roamImport?: RoamImportWindowAPI
  }
}

let installed = false

export const ensureRoamImportWindowHook = (repo: Repo) => {
  if (installed) return
  installed = true

  omnilinerNamespace().roamImport = {
    run: (pages, options = {}) => {
      const workspaceId = options.workspaceId ?? repo.activeWorkspaceId
      if (!workspaceId) {
        throw new Error('No active workspace; pass {workspaceId} or set repo.activeWorkspaceId')
      }
      return importRoam(pages, repo, {
        workspaceId,
        currentUserId: options.currentUserId ?? repo.user.id,
        dryRun: options.dryRun,
        onProgress: options.onProgress ?? (msg => console.log(`[roam-import] ${msg}`)),
      })
    },
    plan: planImport,
  }
}
