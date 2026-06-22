import { useQuery, usePowerSync } from '@powersync/react'
import { Copy, Lock, RotateCcw, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { extractBlockDetails, parseRejectionError, shortenId, summarizeOp } from './rejectedHelpers.ts'

interface RejectedRow {
  id: number
  original_id: number
  tx_id: number
  data: string
  error_code: string | null
  error_message: string | null
  rejected_at: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RejectionDialog({open, onOpenChange}: Props) {
  const db = usePowerSync()
  const rows = useQuery<RejectedRow>(
    'SELECT id, original_id, tx_id, data, error_code, error_message, rejected_at FROM ps_crud_rejected ORDER BY rejected_at DESC',
    [],
    {reportFetching: false},
  )
  // Resolve a block's workspace_id to a readable name. Falls back to a short id
  // when the workspace is gone (a rejection can outlive the workspace it
  // referenced — e.g. the user deleted it), which is itself a useful signal.
  const workspaces = useQuery<{id: string; name: string}>(
    'SELECT id, name FROM workspaces',
    [],
    {reportFetching: false},
  )
  const workspaceNameById = useMemo(
    () => new Map(workspaces.data.map(workspace => [workspace.id, workspace.name])),
    [workspaces.data],
  )
  const workspaceLabel = (workspaceId: string): string =>
    workspaceNameById.get(workspaceId) ?? shortenId(workspaceId)
  const [copiedId, setCopiedId] = useState<number | null>(null)

  const handleRetry = async (row: RejectedRow) => {
    // Re-queue the rejected op for upload. If the underlying issue
    // hasn't been fixed (e.g. parent still missing server-side), the
    // upload handler will quarantine it again on the next pass.
    await db.writeTransaction(async tx => {
      await tx.execute(
        'INSERT INTO ps_crud (tx_id, data) VALUES (?, ?)',
        [row.tx_id, row.data],
      )
      await tx.execute(
        'DELETE FROM ps_crud_rejected WHERE id = ?',
        [row.id],
      )
    })
  }

  const handleDismiss = async (row: RejectedRow) => {
    await db.execute('DELETE FROM ps_crud_rejected WHERE id = ?', [row.id])
  }

  const handleCopy = async (row: RejectedRow) => {
    const payload = {
      tx_id: row.tx_id,
      data: safeParseJson(row.data),
      error_code: row.error_code,
      error: safeParseJson(row.error_message ?? '') ?? row.error_message,
      rejected_at: new Date(row.rejected_at).toISOString(),
    }
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    setCopiedId(row.id)
    setTimeout(() => setCopiedId(current => (current === row.id ? null : current)), 1500)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rejected sync changes</DialogTitle>
          <DialogDescription>
            {rows.data.length === 0
              ? 'No rejected changes — your local edits are all syncing.'
              : `${rows.data.length} change${rows.data.length === 1 ? '' : 's'} the server refused. Retry once the underlying issue is fixed, or dismiss to clear from this list.`}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {rows.data.map(row => {
            const summary = summarizeOp(row.data)
            const error = parseRejectionError(row.error_message)
            const details = extractBlockDetails(row.data)
            return (
              <div key={row.id} className="rounded-md border bg-card p-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-muted-foreground">
                      {summary.op} {summary.table} {summary.idShort}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      {details.workspaceId && (
                        <span>
                          workspace <span className="font-mono">{workspaceLabel(details.workspaceId)}</span>
                        </span>
                      )}
                      {details.fields.length > 0 && (
                        <span>
                          fields <span className="font-mono">{details.fields.join(', ')}</span>
                        </span>
                      )}
                      {details.encrypted && (
                        <span className="inline-flex items-center gap-1">
                          <Lock className="h-3 w-3"/>
                          encrypted
                        </span>
                      )}
                    </div>
                    {details.contentPreview && (
                      <div className="mt-1 truncate text-xs text-foreground/80" title={details.contentPreview}>
                        “{details.contentPreview}”
                      </div>
                    )}
                    <div className="mt-1 text-sm">
                      {error.message}
                    </div>
                    {(error.code || error.details) && (
                      <div className="mt-1 font-mono text-xs text-muted-foreground">
                        {error.code && <span>code {error.code}</span>}
                        {error.code && error.details && <span> · </span>}
                        {error.details && <span>{error.details}</span>}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-muted-foreground">
                      {new Date(row.rejected_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRetry(row)}
                      title="Re-queue this change for upload"
                    >
                      <RotateCcw className="mr-1 h-3.5 w-3.5"/>
                      Retry
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCopy(row)}
                      title="Copy payload and error to clipboard"
                    >
                      <Copy className="mr-1 h-3.5 w-3.5"/>
                      {copiedId === row.id ? 'Copied' : 'Copy'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDismiss(row)}
                      title="Remove from this list (does not affect local data)"
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5"/>
                      Dismiss
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
