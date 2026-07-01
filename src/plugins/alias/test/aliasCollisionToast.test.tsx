// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MergeIntoDescendantError } from '@/data/api'
import type { Repo } from '@/data/repo'
import { AliasCollisionToast } from '../AliasCollisionToast.tsx'

// The component surfaces failures via the toast helpers; mock them so the
// test asserts on the calls instead of mounting a real toaster.
vi.mock('@/utils/toast.js', () => ({
  showError: vi.fn(),
  dismissToast: vi.fn(),
}))
import { showError } from '@/utils/toast.js'

const baseProps = {
  toastId: 'toast-1',
  message: 'collision',
  alias: 'Q4',
  attemptedOn: 'ancestor',
  conflictingBlockId: 'descendant',
  conflictingBlockTitle: 'Q4 Plans',
  workspaceId: 'ws-1',
  offerMerge: true,
}

const renderToast = (run: Repo['run']) =>
  render(<AliasCollisionToast {...baseProps} repo={{run} as Repo} />)

describe('AliasCollisionToast — merge-into-descendant (#188)', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('hides the doomed Merge button on a MergeIntoDescendantError, keeping Open for manual fixup', async () => {
    const run = vi.fn().mockRejectedValue(new MergeIntoDescendantError('descendant', 'ancestor'))
    renderToast(run as unknown as Repo['run'])

    const mergeButton = screen.getByRole('button', {name: /Merge into/})
    await act(async () => { fireEvent.click(mergeButton) })

    // The button that can never succeed is gone — no more stuck retry loop.
    expect(screen.queryByRole('button', {name: /Merge into/})).not.toBeInTheDocument()
    // Open stays available so the user can resolve the nesting manually.
    expect(screen.getByRole('button', {name: 'Open'})).toBeEnabled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.mocked(showError).mock.calls[0]?.[0]).toContain('nested inside')
  })

  it('keeps the Merge button for an ordinary merge failure so the user can retry', async () => {
    const run = vi.fn().mockRejectedValue(new Error('transient boom'))
    renderToast(run as unknown as Repo['run'])

    const mergeButton = screen.getByRole('button', {name: /Merge into/})
    await act(async () => { fireEvent.click(mergeButton) })

    // Non-precondition failures stay retryable: button present and re-enabled.
    expect(screen.getByRole('button', {name: /Merge into/})).toBeEnabled()
    expect(vi.mocked(showError).mock.calls[0]?.[0]).toBe('transient boom')
  })
})
