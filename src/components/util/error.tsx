import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useSignOut } from '@/components/Login.js'
import type { FallbackProps } from 'react-error-boundary'
import { corruptErrorUserId } from '@/utils/localDbCorruption.js'
import { handoffErrorUserId, isLocalDbVfsHandoffError } from '@/data/localDbVfs.js'
import { LocalDbCorruptionFallback } from '@/components/util/LocalDbCorruptionFallback.js'
import { downloadLocalDbBackup } from '@/utils/localDbRecovery.js'
import {
  getLocalDbCorruptionSnapshot,
  subscribeLocalDbCorruption,
} from '@/data/localDbCorruptionSignal.js'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Bridges a RUNTIME local-DB corruption into the bootstrap ErrorBoundary. A
 * corrupt already-open DB surfaces inside the PowerSync sync worker, not as a
 * React render throw, so nothing would reach the boundary. Mounted as a sibling
 * of RepoProvider INSIDE the ErrorBoundary, this reads the latched signal and
 * throws it during render → BootstrapErrorFallback → LocalDbCorruptionFallback
 * (same Export + Reset flow as the open-time case). See localDbCorruptionSignal.
 */
export function LocalDbCorruptionSentinel(): null {
  const error = useSyncExternalStore(subscribeLocalDbCorruption, getLocalDbCorruptionSnapshot)
  if (error) throw error
  return null
}

export function FallbackComponent({error}: FallbackProps) {
  return <div>Something went wrong: {errorMessage(error)}</div>
}

// Top-level error fallback for bootstrap / app-shell failures. Anything that
// reaches here means we couldn't render the App at all — show a friendly UI
// with recovery actions instead of a blank screen or a raw stack trace.
//
// Reload is the cheap retry: if blocks for a recently-joined workspace
// finally arrived, the next bootstrap succeeds. Sign-out is the escape
// hatch when state is genuinely poisoned (auth, per-user db corruption).
// We don't clear localStorage here — `recallRememberedWorkspace` already
// falls through cleanly when the remembered id no longer resolves locally,
// and PowerSync removes rows the user lost access to, so localStorage is
// almost always self-healing.
export function BootstrapErrorFallback({error}: FallbackProps) {
  // A corrupt local SQLite DB gets its own recovery UI (Export + Reset) — the
  // generic Reload/Sign out below can't fix a malformed file. See
  // localDbCorruption.ts for how the error is tagged at the DB-open boundary.
  const corruptUserId = corruptErrorUserId(error)
  if (corruptUserId !== null) {
    return <LocalDbCorruptionFallback userId={corruptUserId} detail={errorMessage(error)} />
  }

  // The storage-mode handoff failed. The data is intact and the usual cause is
  // another tab holding the file, so the generic screen's Sign out is a red
  // herring — it leaves the DB alone and reads as the escalation path.
  if (isLocalDbVfsHandoffError(error)) {
    return <LocalDbHandoffFallback detail={errorMessage(error)} userId={handoffErrorUserId(error)} />
  }

  return <GenericBootstrapErrorFallback error={error} />
}

function LocalDbHandoffFallback({detail, userId}: {detail: string; userId: string | null}) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  // Every one of these refusals leaves the user unable to open their database,
  // and some of them tell the user to take a backup — so offer the one action
  // that works without an open connection, rather than only Reload.
  const handleExport = async () => {
    if (!userId) return
    setBusy(true)
    setStatus('Preparing download…')
    try {
      const {filename, size} = await downloadLocalDbBackup(userId)
      setStatus(`Download started for ${filename} (${(size / 1024 / 1024).toFixed(1)} MiB).`)
    } catch (err) {
      setStatus(`Couldn't export the database: ${errorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Couldn&apos;t open your local database</h1>
          <p className="text-sm text-muted-foreground">
            Your notes are still on this device — this is about how they&apos;re stored, not the
            data itself.
          </p>
        </div>
        <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">
          {detail}
        </pre>
        {status && <p className="text-sm text-muted-foreground">{status}</p>}
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          {userId && (
            <Button variant="outline" onClick={handleExport} disabled={busy}>
              {busy ? 'Exporting…' : 'Export a backup'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function GenericBootstrapErrorFallback({error}: {error: unknown}) {
  const signOut = useSignOut()

  const handleSignOut = async () => {
    try {
      await signOut()
    } catch (err) {
      console.error('Sign-out failed', err)
      window.location.reload()
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t open your workspace. Try reloading — if that
            doesn&apos;t help, sign out to fully reset.
          </p>
        </div>
        <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">
          {errorMessage(error)}
        </pre>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => window.location.reload()} className="flex-1">
            Reload
          </Button>
          <Button variant="outline" onClick={() => void handleSignOut()} className="flex-1">
            Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}
