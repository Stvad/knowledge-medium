// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ReschedulePicker, type ReschedulePickerProps } from '../ReschedulePicker.tsx'

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

/** Render the sheet as `openDialog` would — with props + finalize
 *  callbacks. Returns the spies so tests can assert resolve/cancel. */
const renderPicker = (props: Partial<ReschedulePickerProps> = {}) => {
  const resolve = vi.fn()
  const cancel = vi.fn()
  render(
    <ReschedulePicker blockId="block-1" workspaceId="ws-1" resolve={resolve} cancel={cancel} {...props} />,
  )
  return {resolve, cancel}
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

    renderPicker({
      anchorRect: {
        bottom: 780,
        height: 20,
        left: 600,
        right: 620,
        top: anchorTop,
        width: 20,
      },
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

  it('resolves with rescheduled: true once a date is committed', async () => {
    const {resolve} = renderPicker()

    const todayChip = await screen.findByRole('button', {hidden: true, name: 'Today'})
    await act(async () => {
      todayChip.click()
    })

    await waitFor(() => expect(resolve).toHaveBeenCalledWith({rescheduled: true}))
    expect(mocks.adapter.setIso).toHaveBeenCalledTimes(1)
  })

  it('cancels when dismissed without committing', async () => {
    const {cancel} = renderPicker()

    const cancelButton = await screen.findByRole('button', {hidden: true, name: 'Cancel'})
    await act(async () => {
      cancelButton.click()
    })

    expect(cancel).toHaveBeenCalled()
    expect(mocks.adapter.setIso).not.toHaveBeenCalled()
  })
})
