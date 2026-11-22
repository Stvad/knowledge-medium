import {isAuthRetryableFetchError, type SupabaseClient, type Session} from '@supabase/supabase-js'
import {readPersistedSession} from '@/services/supabase'

export async function restoreHeadlessSession(auth: Pick<SupabaseClient['auth'], 'refreshSession'>): Promise<Session> {
  const {data, error} = await auth.refreshSession()
  if (isAuthRetryableFetchError(error)) {
    const cached = readPersistedSession()
    if (cached?.expires_at && cached.expires_at > Date.now() / 1000) return cached
    throw new Error('Session refresh is unavailable. Restore the connection and restart the host.')
  }
  if (error || !data.session) throw new Error('Session unavailable. Run headless login.')
  return data.session
}
