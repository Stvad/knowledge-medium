import { createContext, useContext, useEffect, useState, ReactNode, FormEvent } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useLocalStorage } from 'react-use'
import { User } from '@/types.ts'
import { hasSupabaseAuthConfig, sessionUserToAppUser, supabase } from '@/services/supabase.ts'
import { hasRemoteSyncConfig } from '@/services/powersync.ts'
import { Session } from '@supabase/supabase-js'

interface UserContextType {
  user: User
  setUser: (user?: User) => void
  signOut: () => Promise<void>
  // True when this session is running without remote sync — either because
  // VITE_SUPABASE_*/VITE_POWERSYNC_URL aren't configured (LocalLogin is the
  // only path), or because the user explicitly chose "Use without sync" on
  // the Supabase login screen. Consumers gate Supabase-dependent UI/RPCs on
  // this so they don't blow up when the client isn't reachable.
  localOnly: boolean
}

const UserContext = createContext<UserContextType | undefined>(undefined)

export const useUser = () => {
  const context = useContext(UserContext)
  if (!context) throw new Error('useUser must be used within a Login component')
  return context.user
}

export const useSignOut = () => {
  const context = useContext(UserContext)
  if (!context) throw new Error('useSignOut must be used within a Login component')
  return context.signOut
}

/** True when the active session has remote sync disabled. Use this to gate
 *  Supabase RPC calls and UI that only makes sense with a remote backend
 *  (member management, invitations, etc.). */
export const useIsLocalOnly = () => {
  const context = useContext(UserContext)
  if (!context) throw new Error('useIsLocalOnly must be used within a Login component')
  return context.localOnly
}

const LOCAL_ONLY_STORAGE_KEY = 'ftm.localOnly'

const clearLocalOnlyOptIn = () => {
  try {
    window.localStorage.removeItem(LOCAL_ONLY_STORAGE_KEY)
  } catch {
    // ignore (incognito, quota, etc.)
  }
}

export function Login({children}: { children: ReactNode }) {
  const [localOnlyOptIn, setLocalOnlyOptIn] = useLocalStorage<boolean>(
    LOCAL_ONLY_STORAGE_KEY,
    false,
  )
  const supabaseAvailable = hasSupabaseAuthConfig && supabase

  if (supabaseAvailable && !localOnlyOptIn) {
    return (
      <SupabaseLogin onContinueLocally={() => setLocalOnlyOptIn(true)}>
        {children}
      </SupabaseLogin>
    )
  }

  return (
    <LocalLogin
      // When Supabase is configured but the user opted into local-only,
      // sign-out should drop the opt-in so they land back on the email
      // login on their next render — not stay locked in local-only forever.
      clearLocalOnlyOnSignOut={Boolean(supabaseAvailable)}
    >
      {children}
    </LocalLogin>
  )
}

interface LocalLoginProps {
  children: ReactNode
  // True when Supabase is wired up but the user opted into local-only.
  // Drives sign-out behavior (also clear the opt-in + reload) and the
  // "Back to sign in" escape hatch on the name-entry screen.
  clearLocalOnlyOnSignOut?: boolean
}

function LocalLogin({children, clearLocalOnlyOnSignOut}: LocalLoginProps) {
  const [user, setUser] = useLocalStorage<User | undefined>('ftm.user', undefined)
  const [name, setName] = useState('')

  if (user) {
    const signOut = async () => {
      setUser(undefined)
      if (clearLocalOnlyOnSignOut) {
        clearLocalOnlyOptIn()
        // Reload so the top-level Login re-reads localStorage and falls back
        // to SupabaseLogin. Without the reload, useLocalStorage's in-memory
        // copy stays at `true` for this tab.
        window.location.reload()
      }
    }
    return (
      <UserContext value={{user, setUser, signOut, localOnly: true}}>
        {children}
      </UserContext>
    )
  }

  const userName = name.trim()

  const updateUser = () => {
    if (userName) {
      setUser({id: userName, name: userName})
    }
  }

  const cancelLocalOnly = () => {
    clearLocalOnlyOptIn()
    window.location.reload()
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-bold text-center">Thought Medium</h1>
        {clearLocalOnlyOnSignOut && (
          <p className="text-xs text-muted-foreground text-center">
            Local-only mode — your data stays on this device and isn&apos;t
            synced to the cloud.
          </p>
        )}
        <div className="space-y-2">
          <Input
            placeholder="Enter your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') updateUser()
            }}
          />
          <Button
            className="w-full"
            onClick={() => updateUser()}
          >
            Enter
          </Button>
          {clearLocalOnlyOnSignOut && (
            <Button
              variant="ghost"
              className="w-full"
              onClick={cancelLocalOnly}
            >
              Back to sign in
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

type Stage = 'enter-email' | 'enter-code'

interface SupabaseLoginProps {
  children: ReactNode
  onContinueLocally: () => void
}

function SupabaseLogin({children, onContinueLocally}: SupabaseLoginProps) {
  const client = supabase!
  const [session, setSession] = useState<Session | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [stage, setStage] = useState<Stage>('enter-email')
  const [submitting, setSubmitting] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    void client.auth.getSession().then(({data}) => {
      if (!isMounted) return
      setSession(data.session ?? null)
      setInitializing(false)
    })

    const {data: listener} = client.auth.onAuthStateChange((_event, next) => {
      if (!isMounted) return
      setSession(next)
      if (next) {
        setError(null)
        setCode('')
      }
    })

    return () => {
      isMounted = false
      listener.subscription.unsubscribe()
    }
  }, [client])

  if (initializing) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    )
  }

  if (session) {
    const user = sessionUserToAppUser(session)
    const signOut = async () => {
      const {error: err} = await client.auth.signOut()
      if (err) {
        console.error('Sign-out failed', err)
      }
      // We DON'T wipe the local PowerSync database. Per-user databases
      // (see src/data/repoInstance.ts) mean this user's local SQLite is
      // already isolated from any other user's; signing back in as the
      // same user reopens it and unsynced edits resume uploading. A
      // different user signs into a fresh database.
      window.location.reload()
    }
    // Even with a Supabase session, the runtime can still be in local-only
    // mode if VITE_POWERSYNC_URL is missing — `hasRemoteSyncConfig` covers
    // both env-var holes; consumers should gate on it.
    return (
      <UserContext
        value={{user, setUser: () => {}, signOut, localOnly: !hasRemoteSyncConfig}}
      >
        {children}
      </UserContext>
    )
  }

  const requestCode = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return

    setError(null)
    setInfo(null)
    setSubmitting(true)

    const {error: err} = await client.auth.signInWithOtp({
      email: trimmed,
      options: {shouldCreateUser: true},
    })

    setSubmitting(false)

    if (err) {
      setError(err.message)
      return
    }

    setStage('enter-code')
    setInfo(`We sent a 6-digit code to ${trimmed}.`)
  }

  const verifyCode = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedCode = code.trim()
    const trimmedEmail = email.trim()
    if (!trimmedCode || !trimmedEmail) return

    setError(null)
    setSubmitting(true)

    const {error: err} = await client.auth.verifyOtp({
      email: trimmedEmail,
      token: trimmedCode,
      type: 'email',
    })

    setSubmitting(false)

    if (err) {
      setError(err.message)
      return
    }
  }

  const continueAnonymously = async () => {
    setError(null)
    setInfo(null)
    setSubmitting(true)

    const {error: err} = await client.auth.signInAnonymously()

    setSubmitting(false)

    if (err) {
      setError(err.message)
    }
  }

  const useDifferentEmail = () => {
    setStage('enter-email')
    setCode('')
    setError(null)
    setInfo(null)
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-bold text-center">Thought Medium</h1>

        {stage === 'enter-code' ? (
          <form onSubmit={verifyCode} className="space-y-3">
            {info && (
              <p className="text-sm text-muted-foreground text-center">{info}</p>
            )}
            <Input
              autoFocus
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={submitting}
            />
            <Button type="submit" className="w-full" disabled={submitting || !code.trim()}>
              {submitting ? 'Verifying…' : 'Verify'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={useDifferentEmail}
              disabled={submitting}
            >
              Use a different email
            </Button>
          </form>
        ) : (
          <form onSubmit={requestCode} className="space-y-3">
            <Input
              autoFocus
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !email.trim()}
            >
              {submitting ? 'Sending…' : 'Send sign-in code'}
            </Button>
          </form>
        )}

        {error && (
          <p className="text-sm text-destructive text-center">{error}</p>
        )}

        <div className="space-y-2">
          <div className="text-xs text-muted-foreground text-center uppercase tracking-wide">
            or
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={continueAnonymously}
            disabled={submitting}
          >
            Continue without an account
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Anonymous sessions are per-device. Sign in with email to invite collaborators.
          </p>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={onContinueLocally}
            disabled={submitting}
          >
            Use without sync (local-only)
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Skip auth entirely. Data stays on this device and never leaves it.
          </p>
        </div>
      </div>
    </div>
  )
}
