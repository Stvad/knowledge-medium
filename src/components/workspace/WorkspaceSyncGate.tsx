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
import { noteColdFirstSync, readWorkspaceFirstSync, recordWorkspaceFirstSync, type WorkspaceFirstSync } from '@/data/workspaceFirstSync'

interface Props {
  workspaceId: string
  workspaceName: string | null
  /** The workspace row has not arrived, so access is undecided: open (to
   *  re-resolve) when it lands, whether or not the workspace is caught up. */
  awaitingRow: boolean
  /** Re-resolve the layout. Called only once the gate should lift, possibly
   *  more than once: the host makes it idempotent per resolve. */
  onReady: () => void
  /** The host's way out — its workspace menu. */
  footer?: ReactNode
}

/** The re-materialization of rows the drain deferred. A pass starts only from
 *  `idle`, so `running` blocks a second and `left`/`failed` wait for the user. */
type Repair =
  | {readonly kind: 'idle' | 'running'}
  // A completed pass left rows unapplied: the one case that may open anyway.
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
  const askAgain = () => setAsks(n => n + 1)

  // Kicks the observer: a drain window that failed retries only on the next
  // arrival, and once the download ends there is none.
  // One kick in flight: every status tick of a long drain re-runs the ask, and
  // each flush would otherwise queue its own pass behind that drain.
  const kicking = useRef<Promise<void> | null>(null)
  // A bulk load while the gate is up — see `BlocksSyncedObserver.holdBulkLoad`.
  useEffect(() => repo.holdBulkSyncLoad(workspaceId), [repo, workspaceId])
  // Must land before the drain applies any of this workspace's rows; once one
  // has, it records nothing.
  useEffect(() => {
    noteColdFirstSync(repo.db, workspaceId)
      .catch((err: unknown) => console.warn('[WorkspaceSyncGate] cold first-sync note failed', err))
  }, [repo, workspaceId])

  const kickDrain = useCallback((): Promise<void> => {
    kicking.current ??= repo.flushSyncObserver().then(
      () => setDrainError(null),
      (err: unknown) => setDrainError(errorMessage(err)),
    ).finally(() => { kicking.current = null })
    return kicking.current
  }, [repo])

  useEffect(() => {
    if (awaitingRow) {
      if (rowLanded) onReady()
      return
    }
    /** Acts on one answer; true when it is waiting on the drain alone. */
    const settle = (state: WorkspaceFirstSync): boolean => {
      if (state.kind !== 'pending') {
        onReady()
        return false
      }
      if (state.gap?.transient === false) setRepair(current => (current.kind === 'idle' ? {kind: 'running'} : current))
      return state.gap?.transient === true
    }
    void (async () => {
      if (!settle(await readWorkspaceFirstSync(repo, workspaceId))) return
      await kickDrain()
      settle(await readWorkspaceFirstSync(repo, workspaceId))
    })().catch((err: unknown) => console.error('[WorkspaceSyncGate] first-sync check failed', err))
  }, [repo, workspaceId, awaitingRow, rowLanded, status, backlog, asks, onReady, kickDrain])

  useEffect(() => {
    if (repair.kind !== 'running') return
    repo.rematerializeWorkspace(workspaceId, {scope: 'unapplied'}).then(
      pass => {
        setRepair(pass.unappliedAfter > 0 ? {kind: 'left', unapplied: pass.unappliedAfter} : {kind: 'idle'})
        setAsks(n => n + 1)
      },
      (err: unknown) => setRepair({kind: 'failed', message: errorMessage(err)}),
    )
  }, [repair.kind, repo, workspaceId])

  const stuck = drainError !== null || repair.kind === 'failed' || repair.kind === 'left'
  const tryAgain = () => {
    setRepair(current => (current.kind === 'running' ? current : {kind: 'idle'}))
    askAgain()
  }
  const openAnyway = async () => {
    await recordWorkspaceFirstSync(repo.db, workspaceId)
    onReady()
  }

  const name = workspaceName ? `"${workspaceName}"` : 'this workspace'
  return (
    <GateCard title={`Opening ${name}…`} footer={footer}>
      <Explanation>
        {awaitingRow
          ? 'Waiting for this workspace to arrive from the server.'
          : 'Getting this workspace onto this device. It opens once everything has arrived.'}
      </Explanation>
      <SyncProgress showConnection>
        {repair.kind === 'running' && <ProgressRow label="Re-applying downloaded rows" detail={null}/>}
      </SyncProgress>
      {drainError && <p className="text-sm text-destructive">Applying synced changes failed: {drainError}</p>}
      {repair.kind === 'failed' && (
        <p className="text-sm text-destructive">Re-applying downloaded rows failed: {repair.message}</p>
      )}
      {repair.kind === 'left' && (
        <p className="text-sm text-destructive">
          {repair.unapplied.toLocaleString()} downloaded row(s) of this workspace could not be applied on
          this device. Opening it now may show it incomplete.
        </p>
      )}
      {repair.kind === 'left' && (
        <Button type="button" variant="secondary" className="w-full" onClick={() => void openAnyway()}>
          Open anyway
        </Button>
      )}
      {stuck && (
        <Button type="button" variant="secondary" className="w-full" onClick={tryAgain}>
          Try again
        </Button>
      )}
    </GateCard>
  )
}
