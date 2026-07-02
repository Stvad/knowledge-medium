/**
 * Results view for an on-demand data-integrity audit (L3). Opened by the
 * `run_data_integrity_audit` action (fresh run) and the
 * `view_data_integrity_audit` action (re-open the LAST run) via
 * `openDialog(ConsistencyAuditDialog)`.
 *
 * The results are read live from the audit store (the last published
 * `ConsistencyAuditResult`), so the dialog can be re-opened to inspect the last
 * run WITHOUT re-running the expensive audit, and refreshes in place when the
 * "Re-run" button publishes a new result.
 *
 * Shows every check that ran with its status, an exact count breakdown, and a
 * small sample of offending block ids — each shown in FULL, click-to-copy, and
 * click-to-open in the side panel (the dialog stays open so you don't lose the
 * results). The FULL per-block list and precise per-ref diffs stay the bridge
 * eval's job (scripts/data-integrity/consistency-check.eval.js) — this is the
 * in-app lead.
 *
 * Rendered non-modal with no dimming overlay so opening a sample in the side
 * panel is actually visible while the dialog floats — close it with Escape or
 * the ✕; an outside click is intentionally NOT a close (see below).
 */
import { useState, useSyncExternalStore } from 'react'
import { AlertTriangle, CheckCircle2, CircleAlert, Copy, Check, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { useHash } from 'react-use'
import { cn } from '@/lib/utils.js'
import { useNavigate } from '@/utils/navigation.js'
import { buildAppHash } from '@/utils/routing.js'
import { useRepo } from '@/context/repo.js'
import { showError } from '@/utils/toast.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import {
  getConsistencyAuditSnapshotFor,
  subscribeConsistencyAudit,
} from './store.js'
import { runConsistencyAuditNow } from './schedule.js'
import type { ConsistencyCheckResult } from './audit.js'

const num = (c: ConsistencyCheckResult, key: string): number => Number(c[key] ?? 0)
const samplesOf = (c: ConsistencyCheckResult): string[] =>
  Array.isArray(c.samples) ? (c.samples as string[]) : []

interface CheckView {
  label: string
  detail: string
  /** count of offending rows (drives the "+N more" beyond the sample). */
  offending: number
}

function describeCheck(name: string, c: ConsistencyCheckResult): CheckView {
  if (name === 'references_index_mirror') {
    const parts: string[] = []
    if (num(c, 'missingIndexRows')) parts.push(`${num(c, 'missingIndexRows')} missing`)
    if (num(c, 'extraIndexRows')) parts.push(`${num(c, 'extraIndexRows')} extra`)
    if (num(c, 'orphanSourceRows')) parts.push(`${num(c, 'orphanSourceRows')} orphaned`)
    if (num(c, 'duplicateTuples')) parts.push(`${num(c, 'duplicateTuples')} duplicate`)
    if (num(c, 'malformedJson')) parts.push(`${num(c, 'malformedJson')} malformed JSON`)
    return {
      label: 'References index mirror',
      detail: parts.join(', ') || 'consistent',
      offending:
        num(c, 'missingIndexRows') + num(c, 'extraIndexRows') + num(c, 'orphanSourceRows') + num(c, 'duplicateTuples'),
    }
  }
  if (name === 'property_ref_at_rest') {
    const findings = Array.isArray(c.findings)
      ? (c.findings as { prop: string; valuePresentRefAbsent: number }[])
      : []
    return {
      label: 'Property refs at rest',
      detail: findings.length
        ? findings.map((f) => `${f.prop}: ${f.valuePresentRefAbsent}`).join(', ')
        : 'consistent',
      offending: num(c, 'total'),
    }
  }
  if (name === 'local_server_divergence') {
    const parts: string[] = []
    if (num(c, 'strandedLocalOnly')) parts.push(`${num(c, 'strandedLocalOnly')} stranded`)
    if (num(c, 'equalStampStandoff')) parts.push(`${num(c, 'equalStampStandoff')} stalemate`)
    if (num(c, 'localRicherNoPending')) parts.push(`${num(c, 'localRicherNoPending')} unsynced local`)
    if (num(c, 'serverAheadUndrained')) parts.push(`${num(c, 'serverAheadUndrained')} server-ahead (info)`)
    return {
      label: 'Local ↔ server',
      detail: parts.join(', ') || 'converged',
      offending: num(c, 'strandedLocalOnly') + num(c, 'equalStampStandoff') + num(c, 'localRicherNoPending'),
    }
  }
  return { label: name, detail: c.status, offending: c.status === 'anomaly' ? 1 : 0 }
}

const StatusIcon = ({ status }: { status: ConsistencyCheckResult['status'] }) => {
  if (status === 'anomaly') return <CircleAlert className="h-4 w-4 shrink-0 text-destructive" />
  if (status === 'error') return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
}

/** One offending block id: shown in FULL (monospace, wraps so nothing is
 *  truncated). Clicking the id opens it in the side panel; a trailing button
 *  copies the full id to the clipboard. */
function SampleRow({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      // Throws synchronously in an insecure context / older webview where
      // `navigator.clipboard` is undefined — caught below.
      await navigator.clipboard.writeText(id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (error) {
      // Don't fail silently on a feature whose whole point is copyable ids.
      console.error('Clipboard write failed', error)
      showError("Couldn't copy id to the clipboard.")
    }
  }
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onOpen(id)}
        title="Open in side panel"
        className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-muted/70"
      >
        {id}
      </button>
      <button
        type="button"
        onClick={copy}
        title="Copy id"
        aria-label={copied ? 'Copied' : 'Copy id'}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  )
}

const formatCheckedAt = (checkedAt: number): string => {
  const d = new Date(checkedAt)
  return Number.isNaN(d.getTime()) ? 'unknown time' : d.toLocaleString()
}

export interface ConsistencyAuditDialogProps {
  /** Pin the dialog to a specific audited workspace instead of the active one.
   *  The run action passes the workspace it just scanned so a mid-scan workspace
   *  switch can't make the fresh result read as "no audit". Omitted by the "View
   *  last" action → falls back to the active workspace. */
  workspaceId?: string
}

export function ConsistencyAuditDialog({
  cancel,
  workspaceId: pinnedWorkspaceId,
}: DialogContextProps<void> & ConsistencyAuditDialogProps) {
  const repo = useRepo()
  const navigate = useNavigate()
  const [, setHash] = useHash()
  // A workspace pinned by an IN-DIALOG run (empty-state "Run audit" / "Re-run").
  // The run publishes for a specific workspace; if the active workspace changes
  // before it lands, an unpinned "View last" dialog would resubscribe to the new
  // active workspace and hide the fresh result as "no audit has run". Capturing
  // the run's workspace here keeps the dialog showing what it just ran — the same
  // guard the global run action applies via its `workspaceId` prop.
  const [runPinnedWorkspaceId, setRunPinnedWorkspaceId] = useState<string | null>(null)
  // The workspace whose results this dialog shows: an explicitly PINNED one (the
  // run action passes the workspace it just scanned), else one pinned by an
  // in-dialog run, else the active workspace (the "View last…" action). Pinning
  // matters because a run publishes for a specific workspace — if the active
  // workspace changes afterward, an unpinned view would stop matching it.
  const targetWorkspaceId = pinnedWorkspaceId ?? runPinnedWorkspaceId ?? repo.activeWorkspaceId
  // Read ONLY this workspace's result from the per-workspace store. Reading the
  // workspace-scoped entry means a cadenced/manual audit for a DIFFERENT
  // workspace can't blank an open dialog — its subscription value is unchanged by
  // the foreign publish, so the (expensive) result stays put. No run for the
  // target workspace → null → the empty state; a Re-run repopulates it.
  const getSnapshot = () => getConsistencyAuditSnapshotFor(targetWorkspaceId)
  const result = useSyncExternalStore(subscribeConsistencyAudit, getSnapshot, getSnapshot)
  const [rerunning, setRerunning] = useState(false)

  // Open the block in the Roam-style side panel (sidebar-stack) and — crucially —
  // KEEP the dialog open (it's non-modal), so a click no longer discards the
  // (expensive) audit results. The sample belongs to THIS dialog's workspace
  // (`result.workspaceId`); if that isn't the active workspace, `navigate` writes
  // the panel into that workspace's layout WITHOUT switching to it, so the click
  // would appear to do nothing. Switch to the sample's workspace first (repo
  // state + hash, exactly like WorkspaceSwitcher) so the opened panel is actually
  // visible, then open the block. No sourcePanelId: a fresh stack is appended at
  // the end of the layout.
  const open = (id: string) => {
    const ws = result?.workspaceId
    if (ws && ws !== repo.activeWorkspaceId) {
      repo.setActiveWorkspaceId(ws)
      setHash(buildAppHash(ws))
    }
    void navigate({ blockId: id, target: 'sidebar-stack', workspaceId: ws })
  }

  const rerun = async () => {
    // Re-run the SHOWN workspace (the pinned/target one), not just whatever is
    // active now, so the refreshed result stays coherent with what's displayed.
    const ws = targetWorkspaceId
    if (!ws) {
      showError('Data integrity audit: no active workspace.')
      return
    }
    // Pin the dialog to the workspace being run so a mid-run active-workspace
    // switch can't hide the fresh result (it publishes under `ws`).
    setRunPinnedWorkspaceId(ws)
    setRerunning(true)
    try {
      // Publishes to the audit store on success → this dialog re-renders with the
      // fresh result via its store subscription.
      await runConsistencyAuditNow(repo, ws)
    } catch (e) {
      showError(`Data integrity audit failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRerunning(false)
    }
  }

  return (
    <Dialog open modal={false} onOpenChange={(isOpen) => { if (!isOpen) cancel() }}>
      <DialogContent
        className="max-w-lg"
        hideOverlay
        // Non-modal + keep-open: interacting with the app behind the dialog (e.g.
        // the side panel a sample just opened) must NOT dismiss it. Close via ✕
        // / Escape only.
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Data integrity audit</DialogTitle>
          <DialogDescription>
            {result
              ? result.anomalies > 0
                ? `${result.anomalies} ${result.anomalies === 1 ? 'check' : 'checks'} flagged an anomaly above the alert threshold.`
                : 'No anomalies above the alert threshold.'
              : 'No audit has run for this workspace yet.'}
          </DialogDescription>
        </DialogHeader>

        {result && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>Last run: {formatCheckedAt(result.checkedAt)}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-xs"
              onClick={() => void rerun()}
              disabled={rerunning}
            >
              <RefreshCw className={cn('h-3 w-3', rerunning && 'animate-spin')} />
              {rerunning ? 'Re-running…' : 'Re-run'}
            </Button>
          </div>
        )}

        {result ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {Object.entries(result.checks).map(([name, check]) => {
              const view = describeCheck(name, check)
              const samples = samplesOf(check)
              return (
                <div key={name} className="rounded-md border p-2">
                  <div className="flex items-center gap-2">
                    <StatusIcon status={check.status} />
                    <div className="text-sm font-medium">{view.label}</div>
                  </div>
                  <div className="mt-0.5 pl-6 text-xs text-muted-foreground">
                    {check.status === 'error'
                      ? `couldn't run: ${String(check.error ?? 'unknown error')}`
                      : view.detail}
                  </div>
                  {samples.length > 0 && (
                    <div className="mt-1 space-y-1 pl-6">
                      <div className="text-[11px] text-muted-foreground">
                        Sample blocks (click to open in side panel, copy for the full id):
                      </div>
                      {samples.map((id) => (
                        <SampleRow key={id} id={id} onOpen={open} />
                      ))}
                      {view.offending > samples.length && (
                        <span className="text-[11px] text-muted-foreground">
                          +{view.offending - samples.length} more
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Run an audit to check data integrity for this workspace.
            </p>
            <Button type="button" onClick={() => void rerun()} disabled={rerunning}>
              <RefreshCw className={cn('h-4 w-4', rerunning && 'animate-spin')} />
              {rerunning ? 'Running…' : 'Run audit'}
            </Button>
          </div>
        )}

        <div className="text-[11px] leading-4 text-muted-foreground">
          Counts are exact; samples are a lead. For the full per-block list and precise per-ref diffs, run the bridge eval
          (<code>scripts/data-integrity/consistency-check.eval.js</code>).
        </div>
      </DialogContent>
    </Dialog>
  )
}
