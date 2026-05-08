/** Pre-warm the PowerSync database off React's render path.
 *
 *  Cold-start instrumentation showed `PowerSync.init()` is the dominant
 *  cost of the outer Suspense fallback (95% of it for a non-trivial DB).
 *  Most of that time is wa-sqlite WASM compile + OPFS handle acquisition
 *  + PowerSync's internal schema, which we can start *before* React's
 *  bundle even begins resolving the Login → RepoProvider tree.
 *
 *  Strategy: read the user id synchronously from localStorage and fire
 *  `ensurePowerSyncReady` immediately. The init promise is memoized
 *  inside that function via `initPromises`, so when `RepoProvider`'s
 *  `use(initRepo(...))` later awaits, it picks up the already-running
 *  (or already-settled) promise.
 *
 *  Best-effort by design: if localStorage is unavailable, the user
 *  hasn't logged in yet, or anything else fails, we silently skip and
 *  the regular React-driven init path takes over.
 */

import { ensurePowerSyncReady } from './repoProvider.ts'
import { hasSupabaseAuthConfig } from '@/services/supabase.ts'
import { hasRemoteSyncConfig } from '@/services/powersync.ts'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim()

const safeParseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const tryReadLocalUserId = (): string | null => {
  try {
    // `useLocalStorage` (react-use) JSON-stringifies on write, so the
    // raw value is `'{"id":"...","name":"..."}'`.
    const parsed = safeParseJson<{id?: unknown}>(window.localStorage.getItem('ftm.user'))
    return parsed && typeof parsed.id === 'string' ? parsed.id : null
  } catch {
    return null
  }
}

const isLocalOnlyOptIn = (): boolean => {
  try {
    // useLocalStorage<boolean> writes `"true"` / `"false"` (JSON).
    const raw = window.localStorage.getItem('ftm.localOnly')
    return raw === '"true"' || raw === 'true'
  } catch {
    return false
  }
}

const tryReadSupabaseUserId = (): string | null => {
  if (!SUPABASE_URL) return null
  try {
    // supabase-js v2 default storageKey: `sb-${ref}-auth-token`
    // where ref is the project subdomain in VITE_SUPABASE_URL. Since we
    // don't override `storageKey` in `supabase.ts`, this matches.
    const ref = new URL(SUPABASE_URL).hostname.split('.')[0]
    const key = `sb-${ref}-auth-token`
    const session = safeParseJson<{user?: {id?: unknown}}>(window.localStorage.getItem(key))
    const id = session?.user?.id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

interface PreWarmTarget {
  userId: string
  useRemoteSync: boolean
}

const resolvePreWarmTarget = (): PreWarmTarget | null => {
  if (typeof window === 'undefined') return null

  // Mirror the runtime decision in `<Login>` / `App.tsx`:
  //   localOnlyOptIn || !supabaseAvailable → LocalLogin (ftm.user)
  //   else                                 → SupabaseLogin (sb-auth-token)
  const localOnly = isLocalOnlyOptIn()
  if (localOnly || !hasSupabaseAuthConfig) {
    const userId = tryReadLocalUserId()
    if (!userId) return null
    return {userId, useRemoteSync: false}
  }
  const userId = tryReadSupabaseUserId()
  if (!userId) return null
  return {userId, useRemoteSync: hasRemoteSyncConfig}
}

let preWarmStarted = false

/** Fire-and-forget. Idempotent — safe to call multiple times; only the
 *  first invocation does work. */
export const preWarmPowerSync = (): void => {
  if (preWarmStarted) return
  preWarmStarted = true

  const target = resolvePreWarmTarget()
  if (!target) {
    if (import.meta.env.DEV) console.log('[suspense] pre-warm: no user id in localStorage; skipped')
    return
  }
  if (import.meta.env.DEV) console.log(`[suspense] pre-warm: starting PowerSync init (useRemoteSync=${target.useRemoteSync})`)

  void ensurePowerSyncReady(target.userId, target.useRemoteSync).catch((error) => {
    // Pre-warm errors are best-effort. The same `ensurePowerSyncReady`
    // call from `RepoProvider`'s `initRepo` will hit the same
    // memoized promise — if it rejected, the React path surfaces it
    // through the bootstrap ErrorBoundary as usual, so we don't need
    // to re-throw here.
    console.warn('[preWarm] PowerSync pre-warm rejected; will surface via React bootstrap', error)
  })
}
