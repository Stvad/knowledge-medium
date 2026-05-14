// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DailyNotePicker } from '../DailyNotePicker.tsx'
import { DailyNotePickerHeaderItem } from '../HeaderItem.tsx'
import {
  openDailyNotePicker,
  openDailyNotePickerEvent,
  type OpenDailyNotePickerEventDetail,
} from '../events.ts'
import {
  OPEN_NEXT_DAILY_NOTE_ACTION_ID,
  OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
} from '../actions.ts'

const mocks = vi.hoisted(() => ({
  getOrCreateDailyNote: vi.fn(async (_repo: unknown, _workspaceId: string, iso: string) => ({
    id: `daily-${iso}`,
  })),
  navigateFromGlobalCommand: vi.fn(),
  repo: {activeWorkspaceId: 'ws-1'},
  runAction: vi.fn(),
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/utils/navigation.ts', () => ({
  useNavigateFromGlobalCommand: () => mocks.navigateFromGlobalCommand,
}))

vi.mock('@/shortcuts/runAction.ts', () => ({
  useRunAction: () => mocks.runAction,
}))

vi.mock('../dailyNotes.ts', async () => {
  const actual = await vi.importActual<typeof import('../dailyNotes.ts')>('../dailyNotes.ts')
  return {
    ...actual,
    getOrCreateDailyNote: mocks.getOrCreateDailyNote,
  }
})

describe('DailyNotePicker', () => {
  afterEach(() => {
    cleanup()
    mocks.getOrCreateDailyNote.mockClear()
    mocks.navigateFromGlobalCommand.mockClear()
    mocks.runAction.mockClear()
  })

  it('opens from the shared event and navigates to the selected daily note', async () => {
    render(<DailyNotePicker/>)

    act(() => {
      openDailyNotePicker({initialIso: '2026-05-13'})
    })

    expect(screen.getByRole('dialog', {name: 'Daily note picker'})).toBeTruthy()

    fireEvent.click(screen.getByRole('button', {name: 'May 13, 2026'}))

    await waitFor(() => {
      expect(mocks.getOrCreateDailyNote).toHaveBeenCalledExactlyOnceWith(
        mocks.repo,
        'ws-1',
        '2026-05-13',
      )
    })
    expect(mocks.navigateFromGlobalCommand).toHaveBeenCalledExactlyOnceWith({
      blockId: 'daily-2026-05-13',
      workspaceId: 'ws-1',
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', {name: 'Daily note picker'})).toBeNull()
    })
  })

  it('lays out the calendar week from Monday', () => {
    render(<DailyNotePicker/>)

    act(() => {
      openDailyNotePicker({initialIso: '2026-05-13'})
    })

    const dialog = screen.getByRole('dialog', {name: 'Daily note picker'})
    expect(dialog.textContent).toContain('MonTueWedThuFriSatSun')

    const dayGrid = dialog.querySelector('.grid.grid-cols-7.gap-1')
    expect(dayGrid).toBeTruthy()
    const cells = Array.from(dayGrid!.children)
    const firstDayIndex = cells.findIndex(cell =>
      cell.getAttribute('aria-label') === 'May 1, 2026',
    )
    expect(firstDayIndex).toBe(4)
  })
})

describe('DailyNotePickerHeaderItem', () => {
  afterEach(() => {
    cleanup()
    mocks.runAction.mockClear()
  })

  it('opens the shared picker from the header button', () => {
    const listener = vi.fn<(event: CustomEvent<OpenDailyNotePickerEventDetail>) => void>()
    const handleEvent: EventListener = event => {
      listener(event as CustomEvent<OpenDailyNotePickerEventDetail>)
    }
    window.addEventListener(openDailyNotePickerEvent, handleEvent)

    render(<DailyNotePickerHeaderItem/>)
    fireEvent.click(screen.getByRole('button', {name: 'Open daily note picker'}))

    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].detail.anchorRect).toBeTruthy()

    window.removeEventListener(openDailyNotePickerEvent, handleEvent)
  })

  it('runs the existing previous and next daily note actions', () => {
    render(<DailyNotePickerHeaderItem/>)

    fireEvent.click(screen.getByRole('button', {name: 'Open previous daily note'}))
    fireEvent.click(screen.getByRole('button', {name: 'Open next daily note'}))

    expect(mocks.runAction).toHaveBeenNthCalledWith(
      1,
      OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
      expect.objectContaining({type: 'daily-note-header-action'}),
    )
    expect(mocks.runAction).toHaveBeenNthCalledWith(
      2,
      OPEN_NEXT_DAILY_NOTE_ACTION_ID,
      expect.objectContaining({type: 'daily-note-header-action'}),
    )
  })
})
