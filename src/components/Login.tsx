import { createContext, useContext, useEffect, useState, ReactNode, FormEvent } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useLocalStorage } from 'react-use'
import { User } from '@/types.ts'
import { hasSupabaseAuthConfig, sessionUserToAppUser, supabase } from '@/services/supabase.ts'
import { Session } from '@supabase/supabase-js'

interface UserContextType {
  user: User
  setUser: (user?: User) => void
}

const UserContext = createContext<UserContextType | undefined>(undefined)

export const useUser = () => {
  const context = useContext(UserContext)
  if (!context) throw new Error('useUser must be used within a Login component')
  return context.user
}

export function Login({children}: { children: ReactNode }) {
  if (hasSupabaseAuthConfig && supabase) {
    return <SupabaseLogin>{children}</SupabaseLogin>
  }

  return <LocalLogin>{children}</LocalLogin>
}

function LocalLogin({children}: { children: ReactNode }) {
  const [user, setUser] = useLocalStorage<User | undefined>('ftm.user', undefined)
  const [name, setName] = useState('')

  if (user) {
    return (
      <UserContext value={{user, setUser}}>
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
  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-bold text-center">Thought Medium</h1>
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
        </div>
      </div>
    </div>
  )
}

type Stage = 'enter-email' | 'enter-code'

function SupabaseLogin({children}: { children: ReactNode }) {
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
    return (
      <UserContext value={{user, setUser: () => {}}}>
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
        </div>
      </div>
    </div>
  )
}
