// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RecentsHeaderItem } from '../HeaderItem.tsx'

// This file covers the button's WIRING only: that it opens with the
// `navigator` role and that the target it hands over is the alias-resolved
// live Recents page (issue #378) rather than the deterministic id. The
// click mechanics the opener performs — synchronous event gating, modifier
// routing, passthrough, veto, error handling — belong to
// `openAsyncBlockFromEvent` and are covered against a real Repo in
// `src/utils/test/navigation.test.ts`. Splitting it this way keeps this file
// from re-testing navigation internals through a mock.
const mocks = vi.hoisted(() => ({
  getOrCreateRecentsPage: vi.fn(async () => ({id: 'claimant'})),
  openBlock: vi.fn(),
  useAsyncBlockOpener: vi.fn(),
  repo: {activeWorkspaceId: 'ws-1'},
}))

vi.mock('@/context/repo.tsx', () => ({ useRepo: () => mocks.repo }))

vi.mock('@/utils/navigation.ts', async () => {
  const actual = await vi.importActual<typeof import('@/utils/navigation.ts')>('@/utils/navigation.ts')
  return {
    ...actual,
    useAsyncBlockOpener: (...args: unknown[]) => {
      mocks.useAsyncBlockOpener(...args)
      return mocks.openBlock
    },
  }
})

// Resolved to a fixed id distinct from any deterministic id, so a passing
// assertion can only mean the button used the RESOLVED page, not a raw one.
vi.mock('@/data/recentsPage.ts', async () => {
  const actual = await vi.importActual<typeof import('@/data/recentsPage.ts')>('@/data/recentsPage.ts')
  return {...actual, getOrCreateRecentsPage: mocks.getOrCreateRecentsPage}
})

afterEach(() => {
  cleanup()
  mocks.getOrCreateRecentsPage.mockClear()
  mocks.openBlock.mockClear()
  mocks.useAsyncBlockOpener.mockClear()
})

const clickAndGetResolver = () => {
  render(<RecentsHeaderItem/>)
  fireEvent.click(screen.getByRole('button', {name: 'Open recents'}))
  expect(mocks.openBlock).toHaveBeenCalledOnce()
  return mocks.openBlock.mock.calls[0]![1] as (ws: string) => Promise<{blockId: string}>
}

describe('RecentsHeaderItem', () => {
  it('opens with the navigator role', () => {
    render(<RecentsHeaderItem/>)
    expect(mocks.useAsyncBlockOpener).toHaveBeenCalledWith({plainClick: 'navigator'})
  })

  it('hands the opener a resolver for the LIVE Recents page, not a deterministic id', async () => {
    const resolveTarget = clickAndGetResolver()

    await expect(resolveTarget('ws-1')).resolves.toEqual({blockId: 'claimant'})
    // Resolved against the workspace the opener supplies, so a gesture that
    // captured a different workspace than `repo.activeWorkspaceId` still lands
    // in its own.
    expect(mocks.getOrCreateRecentsPage).toHaveBeenCalledExactlyOnceWith(mocks.repo, 'ws-1')
  })

  it('does not resolve the page until the opener asks', () => {
    clickAndGetResolver()
    // The click alone must not perform the write: whether the target is needed
    // at all is the opener's decision (a native modifier-click is passthrough).
    expect(mocks.getOrCreateRecentsPage).not.toHaveBeenCalled()
  })
})
