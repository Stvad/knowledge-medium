// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'

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

// isAuthCallbackUrl gates the offline persisted-session fast path: on a magic-
// link / OAuth callback the stored session may belong to a different user, so
// bootstrap must wait for auth-js to resolve the URL instead of mounting the
// stale (wrong-user) session.
describe('isAuthCallbackUrl', () => {
  const storageKey = 'sb-proj-auth-token'

  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  const check = async (url: string) => {
    window.history.replaceState({}, '', url)
    return (await import('./supabase.ts')).isAuthCallbackUrl()
  }

  it('is false for an ordinary URL', async () => {
    expect(await check('/#some-block-route')).toBe(false)
  })

  it('detects an implicit-grant hash (access_token)', async () => {
    expect(await check('/#access_token=abc&refresh_token=def&type=magiclink')).toBe(true)
  })

  it('detects an auth error_description', async () => {
    expect(await check('/?error=access_denied&error_description=expired')).toBe(true)
  })

  it('treats a bare code param as a callback only when a code-verifier is stored', async () => {
    // No verifier → could be an app route that happens to carry `code`; not a
    // callback, so the offline fast path stays available.
    expect(await check('/?code=xyz')).toBe(false)

    window.localStorage.setItem(`${storageKey}-code-verifier`, 'verifier')
    expect(await check('/?code=xyz')).toBe(true)
  })
})

// sessionUserToAppUser drives the display name shown across the app. Its
// getUserName helper is a 4-step fallback chain (metadata name -> email ->
// "Anonymous" -> short id label) that had no coverage; a regression here
// shows a wrong/blank name for whole user classes (anonymous, name-less).
describe('sessionUserToAppUser display-name fallback', () => {
  const appUser = async (user: Record<string, unknown>) => {
    const {sessionUserToAppUser} = await import('./supabase.ts')
    return sessionUserToAppUser({user} as unknown as Session)
  }

  it('prefers a trimmed user_metadata.name over email', async () => {
    const u = await appUser({id: 'u1', user_metadata: {name: '  Alice  '}, email: 'a@b.co'})
    expect(u.name).toBe('Alice')
  })

  it('falls back to email when the metadata name is blank/whitespace', async () => {
    const u = await appUser({id: 'u1', user_metadata: {name: '   '}, email: 'a@b.co'})
    expect(u.name).toBe('a@b.co')
  })

  it('labels anonymous users when there is no name or email', async () => {
    const u = await appUser({id: 'u1', is_anonymous: true})
    expect(u.name).toBe('Anonymous')
  })

  it('falls back to a short user-id label as the last resort', async () => {
    const u = await appUser({id: 'abcdef0123456789'})
    expect(u.name).toBe('User abcdef01')
  })

  it('carries the user id through unchanged', async () => {
    const u = await appUser({id: 'u-42', email: 'a@b.co'})
    expect(u.id).toBe('u-42')
  })
})
