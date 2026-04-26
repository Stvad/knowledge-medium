import { Button } from '@/components/ui/button'
import { useSignOut } from '@/components/Login.tsx'

export function FallbackComponent({error}: { error: Error }) {
  return <div>Something went wrong: {error.message}</div>
}

// Top-level error fallback for bootstrap / app-shell failures. Anything that
// reaches here means we couldn't render the App at all — show a friendly UI
// with recovery actions instead of a blank screen or a raw stack trace.
//
// Common triggers:
//   - URL hash points at a workspace the user no longer has access to (we
//     try to validate access in resolveWorkspaceId, but a slow first-sync
//     can still slip through).
//   - First-sync hasn't replicated any blocks yet for a workspace we just
//     joined, and the throw in resolveWorkspaceId fires.
//   - PowerSync / Supabase config errors at startup.
const LAST_WORKSPACE_STORAGE_KEY = 'ftm.lastWorkspaceId'

const clearStaleStateAndReload = () => {
  try {
    window.localStorage.removeItem(LAST_WORKSPACE_STORAGE_KEY)
  } catch {
    // ignore
  }
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch {
    // ignore
  }
  window.location.reload()
}

export function BootstrapErrorFallback({error}: { error: Error }) {
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
            We couldn&apos;t open your workspace. This usually means the link is
            stale or sync is still catching up.
          </p>
        </div>
        <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">
          {error.message}
        </pre>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={clearStaleStateAndReload} className="flex-1">
            Reset and reload
          </Button>
          <Button variant="outline" onClick={() => void handleSignOut()} className="flex-1">
            Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}
