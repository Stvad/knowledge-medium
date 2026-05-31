import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// readPersistedSession is the load-bearing piece of the offline-boot fix:
// it recovers the last Supabase session straight from storage so the app
// can start before (and instead of being blocked by) getSession()'s token
// refresh. The module reads VITE_SUPABASE_URL at import time, so each test
// stubs the env and re-imports.
describe('readPersistedSession', () => {
  const storageKey = 'sb-proj-auth-token'

  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    window.localStorage.clear()
  })

  const loadSession = async () => (await import('./supabase.ts')).readPersistedSession()

  it('recovers the persisted session even when the access token is expired', async () => {
    // expires_at in the past — getSession() would try (and offline, fail) to
    // refresh this; readPersistedSession hands it back as-is.
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: 'expired-token',
      refresh_token: 'refresh',
      expires_at: 1,
      user: {id: 'user-1'},
    }))

    const session = await loadSession()
    expect(session?.access_token).toBe('expired-token')
    expect(session?.user.id).toBe('user-1')
  })

  it('returns null when nothing is stored', async () => {
    expect(await loadSession()).toBeNull()
  })

  it('returns null for a malformed payload rather than throwing', async () => {
    window.localStorage.setItem(storageKey, 'not-json')
    expect(await loadSession()).toBeNull()
  })

  it('ignores a stored value that is not a usable session', async () => {
    window.localStorage.setItem(storageKey, JSON.stringify({foo: 'bar'}))
    expect(await loadSession()).toBeNull()
  })
})
