import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'

// Drives the SupabaseLogin offline-boot path: the component seeds its session
// from the persisted store, and the auth-state listener must not wipe that
// seed when Supabase emits a null INITIAL_SESSION after an offline token
// refresh fails (only an explicit SIGNED_OUT should clear it).

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void

const fakeSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  expires_at: 1,
  user: {id: 'user-1'},
} as unknown as Session

const mocks = vi.hoisted(() => ({
  persisted: null as Session | null,
  authCallback: null as AuthCallback | null,
  getSession: vi.fn(),
}))

vi.mock('@/services/supabase.js', () => ({
  hasSupabaseAuthConfig: true,
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: (cb: AuthCallback) => {
        mocks.authCallback = cb
        return {data: {subscription: {unsubscribe: vi.fn()}}}
      },
      signOut: vi.fn(async () => ({error: null})),
    },
  },
  readPersistedSession: () => mocks.persisted,
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

describe('SupabaseLogin offline boot', () => {
  beforeEach(() => {
    mocks.persisted = fakeSession
    mocks.authCallback = null
    // Offline: getSession resolves with an error and no session.
    mocks.getSession.mockResolvedValue({data: {session: null}, error: {message: 'offline'}})
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  const renderLogin = async () => {
    const {Login} = await import('./Login.tsx')
    render(
      <Login>
        <div>APP CONTENT</div>
      </Login>,
    )
    // Let the getSession() promise settle.
    await act(async () => {})
  }

  it('keeps the seeded session when a null INITIAL_SESSION arrives offline', async () => {
    await renderLogin()
    expect(screen.getByText('APP CONTENT')).toBeInTheDocument()

    // Supabase emits this after the offline refresh fails — must not log us
    // out, so the app (children) stays mounted.
    emit('INITIAL_SESSION', null)

    expect(screen.getByText('APP CONTENT')).toBeInTheDocument()
  })

  it('clears the session on an explicit SIGNED_OUT', async () => {
    await renderLogin()
    expect(screen.getByText('APP CONTENT')).toBeInTheDocument()

    // A real sign-out still tears the app down (children unmount).
    emit('SIGNED_OUT', null)

    expect(screen.queryByText('APP CONTENT')).not.toBeInTheDocument()
  })
})
