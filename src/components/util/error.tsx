import { Button } from '@/components/ui/button'
import { useSignOut } from '@/components/Login.tsx'
import type { FallbackProps } from 'react-error-boundary'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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
