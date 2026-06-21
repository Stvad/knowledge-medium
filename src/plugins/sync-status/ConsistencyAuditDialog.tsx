/**
 * Results view for an on-demand data-integrity audit (L3). Opened by the
 * `run_data_integrity_audit` action (command palette + sync-status dropdown
 * button) via `openDialog(ConsistencyAuditDialog, {result})`.
 *
 * Shows every check that ran with its status, an exact count breakdown, and a
 * small sample of offending block ids (click to navigate). The FULL per-block
 * list and precise per-ref diffs stay the bridge eval's job
 * (scripts/data-integrity/consistency-check.eval.js) — this is the in-app lead.
 */
import { AlertTriangle, CheckCircle2, CircleAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { useNavigate } from '@/utils/navigation.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import type {
  ConsistencyAuditResult,
  ConsistencyCheckResult,
} from '@/data/internals/consistencyAudit.js'

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

export interface ConsistencyAuditDialogProps {
  result: ConsistencyAuditResult
}

export function ConsistencyAuditDialog({
  result,
  resolve,
  cancel,
}: DialogContextProps<void> & ConsistencyAuditDialogProps) {
  const navigate = useNavigate()
  const open = (id: string) => {
    resolve()
    navigate({ blockId: id, target: 'active' })
  }

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) cancel() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Data integrity audit</DialogTitle>
          <DialogDescription>
            {result.anomalies > 0
              ? `${result.anomalies} ${result.anomalies === 1 ? 'check' : 'checks'} flagged an anomaly above the alert threshold.`
              : 'No anomalies above the alert threshold.'}
          </DialogDescription>
        </DialogHeader>

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
                  <div className="mt-1 pl-6">
                    <div className="text-[11px] text-muted-foreground">Sample blocks (click to open):</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      {samples.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => open(id)}
                          title={id}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted/70"
                        >
                          {id.slice(0, 8)}
                        </button>
                      ))}
                      {view.offending > samples.length && (
                        <span className="text-[11px] text-muted-foreground">
                          +{view.offending - samples.length} more
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="text-[11px] leading-4 text-muted-foreground">
          Counts are exact; samples are a lead. For the full per-block list and precise per-ref diffs, run the bridge eval
          (<code>scripts/data-integrity/consistency-check.eval.js</code>).
        </div>
      </DialogContent>
    </Dialog>
  )
}
