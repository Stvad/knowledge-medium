/**
 * Stands in for a workspace this device has not caught up on
 * (`workspaceFirstSync`), so bootstrap's get-or-creates find the server's rows
 * instead of minting their own. Read-only and unbootstrapped while it is up.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useStatus } from '@powersync/react'
import { Button } from '@/components/ui/button'
import { Explanation, GateCard } from '@/components/workspace/keyUi'
import { ProgressRow, SyncProgress } from '@/components/workspace/SyncProgress'
import { useRepo } from '@/context/repo'
import { useMaterializeBacklog } from '@/hooks/useMaterializeBacklog'
import { readWorkspaceFirstSync, recordWorkspaceFirstSync, type WorkspaceFirstSync } from '@/data/workspaceFirstSync'

interface Props {
  workspaceId: string
  workspaceName: string | null
  /** The workspace row has not arrived, so access is undecided: open (to
   *  re-resolve) when it lands, whether or not the workspace is caught up. */
  awaitingRow: boolean
  /** Re-resolve the layout. Called at most once, and only on a real
   *  transition — every re-resolve re-suspends the app. */
  onReady: () => void
  /** The host's way out — its workspace menu. */
  footer?: ReactNode
}

/** The one-shot re-materialization of rows the drain deferred. */
type Repair =
  | {readonly kind: 'idle' | 'running'}
  /** A completed pass left rows unapplied: the one case that may open anyway. */
  | {readonly kind: 'left'; readonly unapplied: number}
  | {readonly kind: 'failed'; readonly message: string}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function WorkspaceSyncGate({workspaceId, workspaceName, awaitingRow, onReady, footer}: Props) {
  const repo = useRepo()
  const status = useStatus()
  const backlog = useMaterializeBacklog()
  const {data: rows} = useQuery<{id: string}>('SELECT id FROM workspaces WHERE id = ? LIMIT 1', [workspaceId])
  const rowLanded = rows.length > 0
  const [repair, setRepair] = useState<Repair>({kind: 'idle'})
  const [drainError, setDrainError] = useState<string | null>(null)
  const [asks, setAsks] = useState(0)

  const opened = useRef(false)
  const open = useCallback(() => {
    if (opened.current) return
    opened.current = true
    onReady()
  }, [onReady])

  const repairStarted = useRef(false)
  const repairRunning = useRef(false)
  const startRepair = useCallback(() => {
    if (repairStarted.current) return
    repairStarted.current = true
    repairRunning.current = true
    setRepair({kind: 'running'})
    repo.rematerializeWorkspace(workspaceId, {scope: 'unapplied'})
      .then(
        pass => {
          setRepair(pass.unappliedAfter > 0 ? {kind: 'left', unapplied: pass.unappliedAfter} : {kind: 'idle'})
          setAsks(n => n + 1)
        },
        (err: unknown) => setRepair({kind: 'failed', message: errorMessage(err)}),
      )
      .finally(() => { repairRunning.current = false })
  }, [repo, workspaceId])

  // Kicks the observer: a drain window that failed retries only on the next
  // arrival, and once the download ends there is none.
  const flushing = useRef<Promise<void> | null>(null)
  const flush = useCallback((): Promise<void> => {
    flushing.current ??= repo.flushSyncObserver().then(
      () => setDrainError(null),
      (err: unknown) => setDrainError(errorMessage(err)),
    ).finally(() => { flushing.current = null })
    return flushing.current
  }, [repo])

  useEffect(() => {
    if (awaitingRow) {
      if (rowLanded) open()
      return
    }
    let live = true
    /** Acts on one answer; true when it is waiting on the drain alone. */
    const settle = (state: WorkspaceFirstSync): boolean => {
      if (!live) return false
      if (state.kind !== 'pending') {
        open()
        return false
      }
      if (state.gap?.transient === false) startRepair()
      return state.gap?.transient === true && !repairRunning.current
    }
    void (async () => {
      if (!settle(await readWorkspaceFirstSync(repo, workspaceId))) return
      await flush()
      settle(await readWorkspaceFirstSync(repo, workspaceId))
    })().catch((err: unknown) => console.error('[WorkspaceSyncGate] first-sync check failed', err))
    return () => { live = false }
  }, [repo, workspaceId, awaitingRow, rowLanded, status, backlog, asks, open, startRepair, flush])

  const openAnyway = async () => {
    await recordWorkspaceFirstSync(repo.db, workspaceId)
    open()
  }

  const name = workspaceName ? `"${workspaceName}"` : 'this workspace'
  return (
    <GateCard title={`Opening ${name}…`} footer={footer}>
      <Explanation>
        {awaitingRow
          ? 'Waiting for this workspace to arrive from the server.'
          : 'Getting this workspace onto this device. It opens once everything has arrived.'}
      </Explanation>
      <SyncProgress>
        {repair.kind === 'running' && <ProgressRow label="Re-applying downloaded rows" detail={null}/>}
      </SyncProgress>
      {drainError && <p className="text-sm text-destructive">Applying synced changes failed: {drainError}</p>}
      {repair.kind === 'failed' && (
        <p className="text-sm text-destructive">Re-applying downloaded rows failed: {repair.message}</p>
      )}
      {repair.kind === 'left' && (
        <>
          <p className="text-sm text-destructive">
            {repair.unapplied.toLocaleString()} downloaded row(s) of this workspace could not be applied on
            this device. Opening it now may show it incomplete.
          </p>
          <Button type="button" variant="secondary" className="w-full" onClick={() => void openAnyway()}>
            Open anyway
          </Button>
        </>
      )}
    </GateCard>
  )
}
