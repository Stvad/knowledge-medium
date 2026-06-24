import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'

// Drives the SupabaseLogin bootstrap, which uses onAuthStateChange as the
// single source of truth and seeds the first render from the persisted
// session for an instant offline paint. Covers: offline boot survives a null
// INITIAL_SESSION (the seed must not be wiped), explicit SIGNED_OUT tears the
// app down, and an auth-callback URL suppresses the stale-session fast path.

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void

const fakeSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  expires_at: 1,
  user: {id: 'user-1'},
} as unknown as Session

const mocks = vi.hoisted(() => ({
  persisted: null as Session | null,
  isCallbackUrl: false,
  authCallback: null as AuthCallback | null,
}))

vi.mock('@/services/supabase.js', () => ({
  hasSupabaseAuthConfig: true,
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthCallback) => {
        mocks.authCallback = cb
        return {data: {subscription: {unsubscribe: vi.fn()}}}
      },
      signOut: vi.fn(async () => ({error: null})),
    },
  },
  readPersistedSession: () => mocks.persisted,
  isAuthCallbackUrl: () => mocks.isCallbackUrl,
  sessionUserToAppUser: (session: Session) => ({id: session.user.id, name: session.user.id}),
}))

vi.mock('@/services/powersync.js', () => ({
  hasRemoteSyncConfig: true,
}))

const emit = (event: AuthChangeEvent, session: Session | null) => {
  act(() => {
    mocks.authCallback?.(event, session)
  })
}

const renderLogin = async () => {
  const {Login} = await import('./Login.tsx')
  render(
    <Login>
      <div>APP CONTENT</div>
    </Login>,
  )
  await act(async () => {})
}

describe('SupabaseLogin bootstrap', () => {
  beforeEach(() => {
    mocks.persisted = fakeSession
    mocks.isCallbackUrl = false
    mocks.authCallback = null
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('paints immediately from the persisted session (offline, no auth event yet)', async () => {
    await renderLogin()
    // No getSession() round-trip and no auth event emitted yet — the seeded
    // session alone renders the app.
    expect(screen.getByText('APP CONTENT')).toBeInTheDocument()
  })

  it('keeps the seeded session when a null INITIAL_SESSION arrives offline', async () => {
    await renderLogin()
    expect(screen.getByText('APP CONTENT')).toBeInTheDocument()

    // auth-js emits this after the offline refresh fails while leaving the
    // session in storage — it must not log us out.
    emit('INITIAL_SESSION', null)

    expect(screen.getByText('APP CONTENT')).toBeInTheDocument()
  })

  it('clears the session on an explicit SIGNED_OUT', async () => {
    await renderLogin()
    expect(screen.getByText('APP CONTENT')).toBeInTheDocument()

    emit('SIGNED_OUT', null)

    expect(screen.queryByText('APP CONTENT')).not.toBeInTheDocument()
  })

  it('does not paint a stale session on an auth-callback URL until it resolves', async () => {
    // A magic-link / OAuth callback is in flight: the persisted session may
    // belong to a different user, so we wait rather than mounting it.
    mocks.isCallbackUrl = true

    await renderLogin()
    expect(screen.queryByText('APP CONTENT')).not.toBeInTheDocument()
    expect(screen.getByText('Loading…')).toBeInTheDocument()

    // Once auth-js resolves the callback into the real session, render it.
    emit('SIGNED_IN', {...fakeSession, user: {id: 'user-2'}} as Session)
    expect(screen.getByText('APP CONTENT')).toBeInTheDocument()
  })
})
