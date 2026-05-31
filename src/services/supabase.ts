import { createClient, Session, User as SupabaseAuthUser } from '@supabase/supabase-js'
import { User } from '@/types.js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

export const hasSupabaseAuthConfig = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = hasSupabaseAuthConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null

// supabase-js namespaces the persisted session under
// `sb-<project-ref>-auth-token`, deriving the ref from the URL hostname's
// first label (see SupabaseClient's `defaultStorageKey`). We recompute it
// here so bootstrap can read the last session synchronously — see
// `readPersistedSession`.
const supabaseAuthStorageKey = supabaseUrl
  ? `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
  : null

// Read the last persisted Supabase session straight out of localStorage,
// WITHOUT going through `supabase.auth.getSession()`.
//
// Why bypass getSession: when the stored access token is expired (or within
// its refresh margin) getSession synchronously triggers a token refresh and
// awaits it. Offline, that refresh retries for ~30s before failing and then
// resolves to a *null* session — which freezes startup and bounces the user
// to the login screen even though they have a perfectly usable local
// database. Reading the raw persisted value lets us boot the app with the
// existing credentials immediately; the background refresh still upgrades
// the token once connectivity returns.
//
// The value supabase-js writes is the Session object serialized with
// JSON.stringify; we tolerate the legacy `{currentSession}` / `{session}`
// envelopes defensively.
export const readPersistedSession = (): Session | null => {
  if (!supabaseAuthStorageKey || typeof window === 'undefined') return null

  let raw: string | null
  try {
    raw = window.localStorage.getItem(supabaseAuthStorageKey)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    const candidate = parsed?.access_token
      ? parsed
      : parsed?.currentSession ?? parsed?.session ?? null
    return candidate?.access_token && candidate?.user ? (candidate as Session) : null
  } catch {
    return null
  }
}

const getUserName = (user: SupabaseAuthUser) => {
  const metadataName = typeof user.user_metadata?.name === 'string'
    ? user.user_metadata.name.trim()
    : ''

  if (metadataName) return metadataName
  if (user.email) return user.email
  if ('is_anonymous' in user && user.is_anonymous === true) return 'Anonymous'
  return `User ${user.id.slice(0, 8)}`
}

export const sessionUserToAppUser = (session: Session): User => ({
  id: session.user.id,
  name: getUserName(session.user),
})
