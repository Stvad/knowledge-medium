import { useQuery, useStatus } from '@powersync/react'
import {
  CircleAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  HardDrive,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { appUpdate, useAppUpdateAvailable } from '@/appUpdate.js'
import { appVersion } from '@/appVersion.js'
import { useIsLocalOnly } from '@/components/Login.js'
import { Button } from '@/components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import { cn } from '@/lib/utils.js'
import {
  getSyncIndicatorView,
  type SyncIndicatorIcon,
  type SyncIndicatorTone,
} from './model.ts'
import {
  formatPendingChanges,
  materializeQueueCountSql,
  uploadQueueCountCap,
  uploadQueueExactCountSql,
  uploadQueuePreviewCountSql,
} from './queueCounts.ts'
import { RejectionDialog } from './RejectionDialog.tsx'
import { useConsistencyAudit } from './useConsistencyAudit.ts'
import { useRepo } from '@/context/repo.js'
import type { ConsistencyAuditResult } from '@/data/internals/consistencyAudit.js'
import { RUN_DATA_INTEGRITY_AUDIT_ACTION_ID } from '@/data/internals/consistencyAuditStore.js'
import { runActionById } from '@/shortcuts/runAction.js'

interface UploadQueueCountRow {
  count: number
}

const uploadQueuePreviewThrottleMs = 1_000
const rejectedCountSql = 'SELECT COUNT(*) AS count FROM ps_crud_rejected'

// Network sync errors are noisy: a dropped connection or a token refresh
// caught mid-flight surfaces an error for a second or two before PowerSync
// recovers on its own. Only treat a network error as worth showing once it
// has persisted continuously for this long; clear it immediately when it
// resolves. (Offline is handled separately — see `SyncStatusHeaderContent`.)
const networkErrorGraceMs = 5_000

// Debounce the *appearance* of an error: surface `message` only after it has
// stayed non-null for `delayMs`, and drop it the instant it clears. Keeps the
// indicator from flashing on transient blips.
function useStableError(message: string | null, delayMs: number): string | null {
  const [stable, setStable] = useState<string | null>(null)
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setStable(message), delayMs)
    // Cleanup runs whenever `message` changes (including back to null), so it
    // both cancels a not-yet-elapsed timer AND clears any previously-shown
    // value. Resetting here is what makes a *recurring* identical error
    // re-serve its full grace window instead of flashing instantly because
    // `stable` still held the old string. (Done in cleanup, not the effect
    // body, to avoid a synchronous in-effect setState.)
    return () => {
      clearTimeout(timer)
      setStable(null)
    }
  }, [message, delayMs])
  // `stable` only equals `message` once the timer has elapsed for the current
  // continuous error; a cleared message returns null immediately.
  return stable === message ? message : null
}

// Tracks the device's network reachability via `navigator.onLine` +
// online/offline events. We use this to decide whether a sync error is mere
// connectivity noise (device offline → show the calm "Offline" chip) or an
// actionable failure (device online but sync still failing → surface it).
function useIsDeviceOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

type SyncStatus = ReturnType<typeof useStatus>

// Theme-aware tones. `success` reads `--success` (per-theme green
// hue) rather than `--primary` so warm-primary palettes like
// sunset-warm don't paint the "synced OK" chip in alarming reds.
// `active` keeps the primary tint — a spinning icon plus primary
// hue communicates "in progress" without colliding with the
// "good/bad" semantic of success/error. `warning` is a softer
// destructive shade so a glance still differentiates "needs
// attention" from a hard error.
const toneClass: Record<SyncIndicatorTone, string> = {
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-destructive/20 bg-destructive/5 text-destructive',
  active: 'border-primary/30 bg-primary/10 text-primary',
  success: 'border-success/30 bg-success/10 text-success',
  local: 'border-border bg-muted/50 text-muted-foreground',
  neutral: 'border-border bg-background text-muted-foreground',
}

const iconByName = {
  alert: CircleAlert,
  'hard-drive': HardDrive,
  upload: CloudUpload,
  sync: RefreshCw,
  offline: CloudOff,
  check: CloudCheck,
} satisfies Record<SyncIndicatorIcon, typeof CircleAlert>

const formatLastSyncedAt = (date: Date | undefined): string => {
  if (!date) return 'Not synced yet'
  return date.toLocaleString()
}

// The build the client is running — the committer-date version (e.g.
// "2026.06.13-1216"). Rendered as quiet metadata: muted, no underline (the
// global `a` rule in index.css adds one, hence the explicit no-underline),
// with a subtle hover tint to hint it links through to the commit. The exact
// SHA lives in the tooltip rather than the label since the link already goes
// to that commit. A local `dev` build (no `define` applied) shows "dev".
function AppVersionValue() {
  const {display, sha, commitUrl} = appVersion
  if (sha === 'dev' || !commitUrl) {
    return <span className="text-muted-foreground">{display}</span>
  }
  return (
    <a
      href={commitUrl}
      target="_blank"
      rel="noreferrer"
      className="text-muted-foreground no-underline transition-colors hover:text-foreground"
      title={`Commit ${sha}`}
    >
      {display}
    </a>
  )
}

// Compact per-check summary (counts) for the dropdown details. `detail` is ''
// when the check found no signal (so the info band can filter those out).
function summarizeAuditCheck(
  name: string,
  check: ConsistencyAuditResult['checks'][string],
): {label: string; detail: string} {
  const n = (key: string): number => Number(check[key] ?? 0)
  if (name === 'references_index_mirror') {
    const parts: string[] = []
    if (n('missingIndexRows')) parts.push(`${n('missingIndexRows')} missing`)
    if (n('extraIndexRows')) parts.push(`${n('extraIndexRows')} extra`)
    if (n('orphanSourceRows')) parts.push(`${n('orphanSourceRows')} orphaned`)
    if (n('duplicateTuples')) parts.push(`${n('duplicateTuples')} duplicate`)
    if (n('malformedJson')) parts.push(`${n('malformedJson')} malformed`)
    return {label: 'References index', detail: parts.join(', ')}
  }
  if (name === 'property_ref_at_rest') {
    const findings = Array.isArray(check.findings)
      ? (check.findings as {prop: string; valuePresentRefAbsent: number}[])
      : []
    return {
      label: 'Property references',
      detail: findings.map((f) => `${f.prop}: ${f.valuePresentRefAbsent}`).join(', '),
    }
  }
  if (name === 'local_server_divergence') {
    const parts: string[] = []
    if (n('strandedLocalOnly')) parts.push(`${n('strandedLocalOnly')} stranded`)
    if (n('equalStampStandoff')) parts.push(`${n('equalStampStandoff')} stalemate`)
    if (n('localRicherNoPending')) parts.push(`${n('localRicherNoPending')} unsynced local`)
    return {label: 'Local vs server', detail: parts.join(', ')}
  }
  return {label: name, detail: ''}
}

// Checks of a given status, summarized. 'anomaly' → the red section (all kept,
// the chip is already red). 'ok' → the informational band, where the caller
// filters on a non-empty `detail` to show only sub-threshold findings that
// carry a real signal (e.g. a benign-baseline count below the alert floor).
function summarizeAuditByStatus(
  result: ConsistencyAuditResult,
  status: 'anomaly' | 'ok',
): {label: string; detail: string}[] {
  return Object.entries(result.checks)
    .filter(([, check]) => check.status === status)
    .map(([name, check]) => summarizeAuditCheck(name, check))
}

export function SyncStatusHeaderItem() {
  const localOnly = useIsLocalOnly()
  const status = useStatus()
  const rejected = useQuery<UploadQueueCountRow>(
    rejectedCountSql,
    [],
    {reportFetching: false},
  )
  const rejectedCount = Number(rejected.data[0]?.count ?? 0)
  // Local-query failures (counting the rejection quarantine) are real and
  // surfaced immediately. Network/sync errors are handled — and offline is
  // distinguished from a genuine error — down in SyncStatusHeaderContent.
  const localErrorMessage = rejected.error?.message ?? null

  // Built-in consistency audit (L3) result — non-zero anomalies escalate the chip.
  // The store is a module global holding the LAST audited workspace's result, so
  // on a workspace switch it can briefly hold another workspace's anomalies. Only
  // surface a result that belongs to the active workspace.
  const repo = useRepo()
  const auditResult = useConsistencyAudit()
  const audit =
    auditResult && auditResult.workspaceId === repo.activeWorkspaceId ? auditResult : null

  if (localOnly) {
    return (
      <SyncStatusHeaderContent
        localOnly={localOnly}
        status={status}
        pendingChanges={0}
        pendingChangesApproximate={false}
        rejectedCount={rejectedCount}
        materializingChanges={0}
        localErrorMessage={localErrorMessage}
        audit={audit}
      />
    )
  }

  return (
    <RemoteSyncStatusHeaderContent
      status={status}
      rejectedCount={rejectedCount}
      baseLocalErrorMessage={localErrorMessage}
      audit={audit}
    />
  )
}

interface RemoteSyncStatusHeaderContentProps {
  status: SyncStatus
  rejectedCount: number
  baseLocalErrorMessage: string | null
  audit: ConsistencyAuditResult | null
}

function RemoteSyncStatusHeaderContent({
  status,
  rejectedCount,
  baseLocalErrorMessage,
  audit,
}: RemoteSyncStatusHeaderContentProps) {
  const queue = useQuery<UploadQueueCountRow>(
    uploadQueuePreviewCountSql,
    [],
    {
      reportFetching: false,
      throttleMs: uploadQueuePreviewThrottleMs,
    },
  )
  const previewCount = Number(queue.data[0]?.count ?? 0)
  const pendingChangesApproximate = previewCount > uploadQueueCountCap
  const pendingChanges = pendingChangesApproximate ? uploadQueueCountCap : previewCount

  // Staged rows the Layout B observer hasn't applied to `blocks` yet. The change
  // queue mutates every drain window, so watch it throttled like the upload
  // preview; it counts down to 0 as the backlog materializes.
  const materializeQueue = useQuery<UploadQueueCountRow>(
    materializeQueueCountSql,
    [],
    {
      reportFetching: false,
      throttleMs: uploadQueuePreviewThrottleMs,
    },
  )
  const materializingChanges = Number(materializeQueue.data[0]?.count ?? 0)

  return (
    <SyncStatusHeaderContent
      localOnly={false}
      status={status}
      pendingChanges={pendingChanges}
      pendingChangesApproximate={pendingChangesApproximate}
      rejectedCount={rejectedCount}
      materializingChanges={materializingChanges}
      localErrorMessage={queue.error?.message ?? baseLocalErrorMessage}
      audit={audit}
    />
  )
}

interface SyncStatusHeaderContentProps {
  localOnly: boolean
  status: SyncStatus
  pendingChanges: number
  pendingChangesApproximate: boolean
  rejectedCount: number
  materializingChanges: number
  localErrorMessage: string | null
  audit: ConsistencyAuditResult | null
}

function SyncStatusHeaderContent({
  localOnly,
  status,
  pendingChanges,
  pendingChangesApproximate,
  rejectedCount,
  materializingChanges,
  localErrorMessage,
  audit,
}: SyncStatusHeaderContentProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const updateAvailable = useAppUpdateAvailable()
  const deviceOnline = useIsDeviceOnline()
  const dataFlow = status.dataFlowStatus
  // Decide whether a sync error is worth showing. When the *device* is
  // offline, any upload/download error is just connectivity noise — show the
  // calm "Offline" chip, not a raw websocket/fetch error. But when the
  // device is online and sync still fails (bad PowerSync endpoint, 401/403
  // credentials, server-side stream failure), the error is actionable and
  // must surface even though PowerSync flips `connected: false` during its
  // retry loop — otherwise the chip is stuck on Offline/Connecting forever
  // and hides the very reason sync isn't working. The grace window below
  // still debounces transient blips in both cases.
  const networkError = deviceOnline
    ? (dataFlow.uploadError?.message ?? dataFlow.downloadError?.message ?? null)
    : null
  const stableNetworkError = useStableError(networkError, networkErrorGraceMs)
  const errorMessage = localErrorMessage ?? stableNetworkError
  const integrityAnomalies = audit?.anomalies ?? 0
  // Anomalies (>= alert threshold) redden the chip; sub-threshold 'ok' checks
  // that still carry a signal (e.g. a benign-baseline count below the floor)
  // surface as muted info so they're visible without alarming.
  const auditAnomalies = audit && integrityAnomalies > 0 ? summarizeAuditByStatus(audit, 'anomaly') : []
  const auditInfos = audit ? summarizeAuditByStatus(audit, 'ok').filter((s) => s.detail) : []
  // A check that threw degrades to status 'error' (not counted as an anomaly, so
  // it doesn't redden the chip) — but surface it so a self-audit that couldn't
  // run doesn't silently read as healthy.
  const auditErroredChecks = audit
    ? Object.entries(audit.checks).filter(([, c]) => c.status === 'error').map(([name]) => name)
    : []
  const hasAuditSection =
    auditAnomalies.length > 0 || auditInfos.length > 0 || auditErroredChecks.length > 0
  // Re-run the built-in audit on demand via the global action (also in the
  // command palette). The action toasts the outcome and republishes the result,
  // so the dropdown's counts refresh in place.
  const runAudit = (): void => {
    try {
      void Promise.resolve(
        runActionById(RUN_DATA_INTEGRITY_AUDIT_ACTION_ID, new CustomEvent('run-data-integrity-audit')),
      ).catch((e) => console.error('Failed to run data-integrity audit', e))
    } catch (e) {
      console.error('Failed to run data-integrity audit', e)
    }
  }
  const view = getSyncIndicatorView({
    localOnly,
    connected: status.connected,
    connecting: status.connecting,
    hasSynced: status.hasSynced,
    uploading: Boolean(dataFlow.uploading),
    downloading: Boolean(dataFlow.downloading),
    pendingChanges,
    pendingChangesApproximate,
    rejectedChanges: rejectedCount,
    materializingChanges,
    downloadFraction: status.downloadProgress?.downloadedFraction ?? null,
    errorMessage,
    lastSyncedAt: status.lastSyncedAt,
    integrityAnomalies,
  })
  const Icon = iconByName[view.icon]

  return (
    <>
      <DropdownMenu open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring sm:h-8 sm:w-8',
              toneClass[view.tone],
            )}
            aria-label={updateAvailable ? `${view.title} — update available` : view.title}
            title={updateAvailable ? `${view.title} — update available` : view.title}
          >
            <Icon className={cn('h-4 w-4', view.spinning && 'animate-spin')}/>
            {updateAvailable && (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background"
              />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 p-3">
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', view.spinning && 'animate-spin')}/>
              <div className="min-w-0">
                <div className="text-sm font-medium">{view.label}</div>
                <div className="text-xs leading-5 text-muted-foreground">{view.title}</div>
              </div>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <div className="text-muted-foreground">Unsynced</div>
              <div className="text-right">
                {detailsOpen ? (
                  <UploadQueueDetails
                    localOnly={localOnly}
                    previewCount={pendingChanges}
                    previewApproximate={pendingChangesApproximate}
                  />
                ) : (
                  formatPendingChanges(pendingChanges, localOnly, pendingChangesApproximate)
                )}
              </div>
              {view.progressPercent !== null && (
                <>
                  <div className="text-muted-foreground">Progress</div>
                  <div className="text-right">{view.progressPercent}%</div>
                </>
              )}
              {materializingChanges > 0 && (
                <>
                  <div className="text-muted-foreground">Processing</div>
                  <div className="text-right">
                    {materializingChanges.toLocaleString()} {materializingChanges === 1 ? 'block' : 'blocks'}
                  </div>
                </>
              )}
              <div className="text-muted-foreground">Last sync</div>
              <div className="text-right">{formatLastSyncedAt(status.lastSyncedAt)}</div>
              <div className="text-muted-foreground">Version</div>
              <div className="text-right">
                <AppVersionValue/>
              </div>
            </div>
            {updateAvailable && (
              <div className="border-t pt-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium">New version available</div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => appUpdate.reload()}
                  >
                    Reload
                  </Button>
                </div>
              </div>
            )}
            {rejectedCount > 0 && (
              <div className="border-t pt-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-destructive">
                    {rejectedCount} {rejectedCount === 1 ? 'change' : 'changes'} couldn't sync
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setDialogOpen(true)}
                  >
                    View
                  </Button>
                </div>
              </div>
            )}
            {auditAnomalies.length > 0 && (
              <div className="border-t pt-2">
                <div className="text-xs font-medium text-destructive">
                  Data integrity: {integrityAnomalies} {integrityAnomalies === 1 ? 'issue' : 'issues'}
                </div>
                <div className="mt-1 space-y-0.5">
                  {auditAnomalies.map((s) => (
                    <div key={s.label} className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                      <div className="text-muted-foreground">{s.label}</div>
                      <div className="text-right">{s.detail || 'anomaly'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {auditInfos.length > 0 && (
              <div className="border-t pt-2">
                <div className="text-xs font-medium">Data integrity — below alert threshold</div>
                <div className="mt-1 space-y-0.5">
                  {auditInfos.map((s) => (
                    <div key={s.label} className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                      <div className="text-muted-foreground">{s.label}</div>
                      <div className="text-right">{s.detail}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  Minor / expected baseline (e.g. cleared values) — not alerting.
                </div>
              </div>
            )}
            {auditErroredChecks.length > 0 && (
              <div className="border-t pt-2 text-[11px] leading-4 text-muted-foreground">
                {auditErroredChecks.length} integrity {auditErroredChecks.length === 1 ? 'check' : 'checks'} couldn't run ({auditErroredChecks.join(', ')}).
              </div>
            )}
            {hasAuditSection && (
              <div className="border-t pt-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] leading-4 text-muted-foreground">
                    Run the consistency-check eval for per-block detail.
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={runAudit}
                  >
                    Re-run audit
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <RejectionDialog open={dialogOpen} onOpenChange={setDialogOpen}/>
    </>
  )
}

interface UploadQueueDetailsProps {
  localOnly: boolean
  previewCount: number
  previewApproximate: boolean
}

function UploadQueueDetails({
  localOnly,
  previewCount,
  previewApproximate,
}: UploadQueueDetailsProps) {
  const queue = useQuery<UploadQueueCountRow>(
    uploadQueueExactCountSql,
    [],
    {
      reportFetching: false,
      runQueryOnce: true,
    },
  )
  const exactCount = queue.data[0]?.count

  if (queue.error) {
    return 'Unable to count unsynced changes'
  }

  if (exactCount === undefined) {
    return formatPendingChanges(previewCount, localOnly, previewApproximate)
  }

  return formatPendingChanges(Number(exactCount), localOnly)
}
