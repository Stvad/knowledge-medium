/**
 * On-demand data-integrity audit (L3) as GLOBAL actions:
 *   - `run_data_integrity_audit` — RUN the audit, then show its results. In the
 *     command palette ("Run data integrity audit") and behind the status
 *     dropdown's "Re-run audit" affordance (via `runActionById`).
 *   - `view_data_integrity_audit` — RE-OPEN the results dialog for the LAST run
 *     WITHOUT re-scanning (cheap). In the command palette ("View last data
 *     integrity audit") and behind the status dropdown's "Inspect" button.
 *
 * Both open `ConsistencyAuditDialog`, which reads the last published result from
 * the audit store — so viewing the last run costs nothing, and a fresh run just
 * republishes into the same store.
 *
 * Lives in the system-status plugin (not core defaultShortcuts) so the action can
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
import {
  RUN_DATA_INTEGRITY_AUDIT_ACTION_ID,
  VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID,
} from '@/plugins/data-integrity/store.js'
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
      // Always show the inspectable result (works clean or with findings). The
      // dialog reads the just-published result from the store; pin it to the
      // audited workspace so a mid-scan workspace switch can't make the fresh
      // result read as "no audit" (the dialog scopes the store snapshot to its
      // workspace).
      void openDialog(ConsistencyAuditDialog, { workspaceId })
    } catch (e) {
      progress.fail(`Data integrity audit failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}

/** View the LAST audit without re-running it — opens the same results dialog,
 *  which reads the last published result from the store (or an empty state with
 *  a "Run audit" button if none has run this session). */
export const viewDataIntegrityAuditAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID,
  description: 'View last data integrity audit',
  context: ActionContextTypes.GLOBAL,
  icon: ShieldCheck,
  handler: () => {
    void openDialog(ConsistencyAuditDialog)
  },
}

export const runDataIntegrityAuditActionContribution = actionsFacet.of(runDataIntegrityAuditAction, {
  source: 'system-status',
})

export const viewDataIntegrityAuditActionContribution = actionsFacet.of(viewDataIntegrityAuditAction, {
  source: 'system-status',
})
