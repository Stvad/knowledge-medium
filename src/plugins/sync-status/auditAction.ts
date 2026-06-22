/**
 * On-demand data-integrity audit (L3) as a GLOBAL action — shows in the command
 * palette ("Run data integrity audit") and is triggered by the "Re-run audit"
 * button in the sync-status dropdown (via `runActionById`).
 *
 * Lives in the sync-status plugin (not core defaultShortcuts) so the action can
 * own its results UI — a progress toast while it runs, then the
 * ConsistencyAuditDialog — without core depending on a plugin component.
 */
import { ShieldCheck } from 'lucide-react'
import { actionsFacet } from '@/extensions/core.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { openDialog } from '@/utils/dialogs.js'
import { showError, showProgress } from '@/utils/toast.js'
import { RUN_DATA_INTEGRITY_AUDIT_ACTION_ID } from '@/plugins/data-integrity/store.js'
import { runConsistencyAuditNow } from '@/plugins/data-integrity/schedule.js'
import { ConsistencyAuditDialog } from './ConsistencyAuditDialog.tsx'

export const runDataIntegrityAuditAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: RUN_DATA_INTEGRITY_AUDIT_ACTION_ID,
  description: 'Run data integrity audit',
  context: ActionContextTypes.GLOBAL,
  icon: ShieldCheck,
  handler: async ({ uiStateBlock }: BaseShortcutDependencies) => {
    const { repo } = uiStateBlock
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) {
      showError('Data integrity audit: no active workspace.')
      return
    }
    const progress = showProgress('Running data integrity audit…')
    try {
      const result = await runConsistencyAuditNow(repo, workspaceId)
      if (result.anomalies > 0) {
        progress.fail(
          `Data integrity: ${result.anomalies} ${result.anomalies === 1 ? 'issue' : 'issues'} found — see details.`,
        )
      } else {
        progress.done('Data integrity audit: no issues found.')
      }
      // Always show the inspectable result (works clean or with findings).
      void openDialog(ConsistencyAuditDialog, { result })
    } catch (e) {
      progress.fail(`Data integrity audit failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}

export const runDataIntegrityAuditActionContribution = actionsFacet.of(runDataIntegrityAuditAction, {
  source: 'sync-status',
})
