import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
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

function SupabaseLogin({children}: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)
  const client = supabase

  useEffect(() => {
    if (!client) return

    let isMounted = true

    const syncSession = async () => {
      setIsLoading(true)
      setAuthError(null)

      const {data, error} = await client.auth.getSession()
      if (error) {
        if (isMounted) {
          setAuthError(error.message)
          setIsLoading(false)
        }
        return
      }

      if (data.session) {
        if (isMounted) {
          setSession(data.session)
          setIsLoading(false)
        }
        return
      }

      const anonymousAuth = await client.auth.signInAnonymously()
      if (anonymousAuth.error) {
        if (isMounted) {
          setAuthError(anonymousAuth.error.message)
          setIsLoading(false)
        }
        return
      }

      if (isMounted) {
        setSession(anonymousAuth.data.session)
        setIsLoading(false)
      }
    }

    void syncSession()

    const {data: authListener} = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!isMounted) return

      setSession(nextSession)
      if (nextSession) {
        setAuthError(null)
      }
      setIsLoading(false)
    })

    return () => {
      isMounted = false
      authListener.subscription.unsubscribe()
    }
  }, [client])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-muted-foreground">Signing in to Supabase…</div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-2xl font-bold">Supabase Sign-In Failed</h1>
          <p className="text-sm text-muted-foreground">
            {authError ?? 'The app could not establish a Supabase session.'}
          </p>
          <p className="text-sm text-muted-foreground">
            Verify `supabase/config.toml` has anonymous sign-ins enabled and that your Vite env vars point at the correct project.
          </p>
        </div>
      </div>
    )
  }

  const user = sessionUserToAppUser(session)

  return (
    <UserContext value={{user, setUser: () => {}}}>
      {children}
    </UserContext>
  )
}
