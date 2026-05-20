// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ReschedulePicker } from '../ReschedulePicker.tsx'
import { openReschedulePicker } from '../rescheduleEvents.ts'

const mocks = vi.hoisted(() => {
  const block = {id: 'block-1'}
  return {
    adapter: {
      id: 'test-adapter',
      getCurrentIso: vi.fn(async () => '2026-05-15'),
      setIso: vi.fn(async () => true),
    },
    block,
    isMobile: false,
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

vi.mock('@/utils/react.tsx', () => ({
  useIsMobile: () => mocks.isMobile,
}))

vi.mock('../blockDateAdapter.ts', () => ({
  pickBlockDateAdapter: () => mocks.adapter,
}))

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  })
}

const mockDialogSize = (width: number, height: number) => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function offsetWidth(
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'dialog' ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function offsetHeight(
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'dialog' ? height : 0
  })
}

describe('ReschedulePicker', () => {
  beforeAll(() => {
    vi.useFakeTimers({toFake: ['Date']})
    vi.setSystemTime(new Date(2026, 4, 15, 12))
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    mocks.adapter.getCurrentIso.mockClear()
    mocks.adapter.setIso.mockClear()
    mocks.repo.block.mockClear()
    mocks.isMobile = false
  })

  it('flips the desktop picker above low anchors instead of clipping below the viewport', async () => {
    const viewportHeight = 800
    const dialogHeight = 560
    const anchorTop = 760

    setViewport(1280, viewportHeight)
    mockDialogSize(448, dialogHeight)

    render(<ReschedulePicker/>)

    await act(async () => {
      openReschedulePicker({
        blockId: 'block-1',
        workspaceId: 'ws-1',
        anchorRect: {
          bottom: 780,
          height: 20,
          left: 600,
          right: 620,
          top: anchorTop,
          width: 20,
        },
      })
    })

    const dialog = await screen.findByRole('dialog', {
      hidden: true,
      name: 'Reschedule block',
    })

    await waitFor(() => {
      expect(dialog.style.visibility).not.toBe('hidden')
    })

    const top = Number.parseFloat(dialog.style.top)
    expect(top).toBeLessThan(anchorTop)
    expect(top + dialogHeight).toBeLessThanOrEqual(viewportHeight)
  })
})
