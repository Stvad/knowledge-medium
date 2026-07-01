// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ErrorBoundary } from 'react-error-boundary'

// The sentinel's fallback (LocalDbCorruptionFallback) pulls in Login hooks +
// recovery plumbing; stub them so this test stays about the routing path.
vi.mock('@/components/Login.js', () => ({
  useSignOut: () => vi.fn(),
  useIsLocalOnly: () => false,
}))
vi.mock('@/utils/localDbRecovery.js', () => ({
  downloadLocalDbBackup: vi.fn(),
  resetLocalDatabase: vi.fn(),
}))

import { BootstrapErrorFallback, LocalDbCorruptionSentinel } from './error'
import {
  __resetLocalDbCorruptionSignalForTest,
  reportRuntimeLocalDbCorruption,
} from '@/data/localDbCorruptionSignal.js'

afterEach(() => {
  __resetLocalDbCorruptionSignalForTest()
  cleanup()
  vi.clearAllMocks()
})

describe('LocalDbCorruptionSentinel', () => {
  it('renders nothing until a runtime corruption is reported', () => {
    render(
      <ErrorBoundary FallbackComponent={BootstrapErrorFallback}>
        <LocalDbCorruptionSentinel />
        <div>app content</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('app content')).toBeTruthy()
  })

  it('routes a reported runtime corruption into the recovery UI via the boundary', () => {
    // Keep the expected React error-boundary console.error from cluttering output.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary FallbackComponent={BootstrapErrorFallback}>
        <LocalDbCorruptionSentinel />
        <div>app content</div>
      </ErrorBoundary>,
    )

    act(() => {
      reportRuntimeLocalDbCorruption(
        'user-1',
        new Error('powersync_control: internal SQLite call returned CORRUPT'),
      )
    })

    // App content is gone; the corruption recovery UI (not the generic fallback)
    // is shown — identified by its unique heading.
    expect(screen.queryByText('app content')).toBeNull()
    expect(screen.getByText('Local database problem')).toBeTruthy()
    spy.mockRestore()
  })
})
