// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceKeyGate } from './WorkspaceKeyGate.tsx'

// The confirm-plaintext branch does real async work in onResolved (the host
// re-materializes the workspace's staged synced rows, then re-resolves to swap
// the gate for the app). On a freshly-wiped device that drain can take a while.
// These cover the feedback that work needs: the button must show progress
// (disabled) while in flight, ignore re-clicks, and recover with a message if
// onResolved rejects — otherwise the click looks dead and the user reloads.

const makeDeferred = () => {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('WorkspaceKeyGate — confirm plaintext feedback', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('disables the confirm button while onResolved is in flight and ignores re-clicks', async () => {
    const deferred = makeDeferred()
    const onResolved = vi.fn(() => deferred.promise)
    render(
      <WorkspaceKeyGate
        userId="u1"
        workspaceId="w1"
        reason="quarantine"
        canary={null}
        onResolved={onResolved}
      />,
    )
    const button = screen.getByRole('button', { name: /this workspace is not encrypted/i })

    await act(async () => {
      fireEvent.click(button)
    })

    expect(onResolved).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()

    // A second click while the drain is in flight must not enqueue another one.
    fireEvent.click(button)
    expect(onResolved).toHaveBeenCalledTimes(1)
  })

  it('re-enables the button and surfaces the error when onResolved rejects', async () => {
    const deferred = makeDeferred()
    const onResolved = vi.fn(() => deferred.promise)
    render(
      <WorkspaceKeyGate
        userId="u1"
        workspaceId="w1"
        reason="quarantine"
        canary={null}
        onResolved={onResolved}
      />,
    )
    const button = screen.getByRole('button', { name: /this workspace is not encrypted/i })

    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()

    await act(async () => {
      deferred.reject(new Error('drain blew up'))
      await deferred.promise.catch(() => {})
    })

    expect(button).toBeEnabled()
    expect(screen.getByText('drain blew up')).toBeInTheDocument()
  })
})
