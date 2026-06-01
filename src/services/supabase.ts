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

// True when the current URL is a Supabase auth callback (magic-link / OTP /
// OAuth redirect) that `detectSessionInUrl` is about to process into a NEW
// session. Mirrors auth-js's own callback detection (`_isImplicitGrantCallback`
// / `_isPKCECallback`): an implicit-grant hash carries `access_token` (or
// `error_description`); a PKCE callback carries `code` AND a stored
// `<storageKey>-code-verifier`. supabase-js reads both the query string and
// the URL hash (hash params win), so we check both.
//
// The code-verifier requirement matters: this app uses hash-based routing, so
// a bare `code` param could appear in a route. Requiring the verifier (which
// auth-js writes only when IT initiated the PKCE flow) avoids a false positive
// that would needlessly suppress the offline fast path.
//
// Bootstrap uses this to skip the persisted-session fast path: when a callback
// is in flight the stored session may belong to a DIFFERENT user (account
// switch / shared device), and per-user PowerSync DBs are keyed by user id —
// rendering from the stale session would briefly mount the wrong user's local
// data. On a callback we wait for auth-js to resolve the URL and emit
// SIGNED_IN with the real session instead.
export const isAuthCallbackUrl = (): boolean => {
  if (!supabaseAuthStorageKey || typeof window === 'undefined') return false
  const {search, hash} = window.location
  const params = new URLSearchParams(search)
  const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const has = (key: string) => params.has(key) || hashParams.has(key)

  if (has('access_token') || has('error_description')) return true

  if (has('code')) {
    try {
      return window.localStorage.getItem(`${supabaseAuthStorageKey}-code-verifier`) !== null
    } catch {
      return false
    }
  }
  return false
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
