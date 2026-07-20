// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { DateScrubOverlay } from '../DateScrubOverlay.tsx'
import {
  applyKeyboardScrubDelta,
  type DateScrubDraft,
  endKeyboardScrub,
  stageDateScrubDraft,
  startKeyboardScrubForTarget,
} from '../dateScrubGesture.ts'

const mocks = vi.hoisted(() => {
  const block = {id: 'block-1'}
  return {
    adapter: {
      id: 'test-adapter',
      canHandle: vi.fn(() => true),
      getCurrentIso: vi.fn(async () => '2026-05-15'),
      setIso: vi.fn(async () => true),
    },
    block,
    commit: vi.fn(async () => undefined),
    repo: {
      block: vi.fn(() => block),
    },
    runtime: {},
  }
})

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/extensions/runtimeContext.ts', () => ({
  useAppRuntime: () => mocks.runtime,
}))

vi.mock('../blockDateAdapter.ts', () => ({
  pickBlockDateAdapter: () => mocks.adapter,
}))

describe('DateScrubOverlay staged commits', () => {
  beforeEach(() => {
    mocks.adapter.getCurrentIso.mockImplementation(async () => '2026-05-15')
  })

  afterEach(() => {
    endKeyboardScrub(false)
    cleanup()
    vi.restoreAllMocks()
    mocks.adapter.getCurrentIso.mockClear()
    mocks.adapter.setIso.mockClear()
    mocks.commit.mockClear()
    mocks.repo.block.mockClear()
  })

  const draft = (
    currentIso: string,
    commit = mocks.commit,
  ): DateScrubDraft => ({
    id: 'srs-good',
    currentIso,
    preview: {
      label: 'SRS GOOD',
      value: currentIso,
      detail: '10d -> 20d',
    },
    shiftDate: deltaDays => draft(deltaDays === 1 ? '2026-05-26' : currentIso, commit),
    commit,
  })

  it('renders a staged preview and only runs its commit callback when scrub commits', async () => {
    render(<DateScrubOverlay/>)
    await act(async () => undefined)

    await act(async () => {
      expect(startKeyboardScrubForTarget({block: mocks.block as Block})).toBe(true)
    })

    await screen.findByText('Scrub date')

    await act(async () => {
      expect(stageDateScrubDraft('block-1', draft('2026-05-25'))).toBe(true)
    })

    expect(screen.getByText('SRS GOOD')).toBeInTheDocument()
    expect(screen.getByText('2026-05-25')).toBeInTheDocument()
    expect(screen.getByText('10d -> 20d')).toBeInTheDocument()

    await act(async () => {
      endKeyboardScrub(false)
    })
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.adapter.setIso).not.toHaveBeenCalled()

    await act(async () => {
      expect(startKeyboardScrubForTarget({block: mocks.block as Block})).toBe(true)
    })
    await screen.findByText('Scrub date')

    await act(async () => {
      expect(stageDateScrubDraft('block-1', draft('2026-05-25'))).toBe(true)
      endKeyboardScrub(true)
    })

    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1))
    expect(mocks.adapter.setIso).not.toHaveBeenCalled()
  })

  it('can commit a staged action before the relative date read resolves', async () => {
    let resolveIso: ((value: string) => void) | null = null
    mocks.adapter.getCurrentIso.mockImplementationOnce(
      () => new Promise<string>(resolve => {
        resolveIso = resolve
      }),
    )

    render(<DateScrubOverlay/>)
    await act(async () => undefined)

    await act(async () => {
      expect(startKeyboardScrubForTarget({block: mocks.block as Block})).toBe(true)
      expect(stageDateScrubDraft('block-1', draft('2026-05-25'))).toBe(true)
      endKeyboardScrub(true)
    })

    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1))
    expect(mocks.adapter.setIso).not.toHaveBeenCalled()

    await act(async () => {
      resolveIso?.('2026-05-15')
    })
  })

  it('shifts the active draft instead of replacing it with plain date scrub state', async () => {
    render(<DateScrubOverlay/>)
    await act(async () => undefined)

    await act(async () => {
      expect(startKeyboardScrubForTarget({block: mocks.block as Block})).toBe(true)
    })
    await screen.findByText('Scrub date')

    await act(async () => {
      expect(stageDateScrubDraft('block-1', draft('2026-05-25'))).toBe(true)
      applyKeyboardScrubDelta(1)
    })

    expect(screen.getByText('SRS GOOD')).toBeInTheDocument()
    expect(screen.getByText('2026-05-26')).toBeInTheDocument()
    expect(screen.getByText('10d -> 20d')).toBeInTheDocument()
  })
})
