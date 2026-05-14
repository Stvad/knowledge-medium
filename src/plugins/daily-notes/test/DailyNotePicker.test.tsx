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

const mocks = vi.hoisted(() => ({
  getOrCreateDailyNote: vi.fn(async (_repo: unknown, _workspaceId: string, iso: string) => ({
    id: `daily-${iso}`,
  })),
  navigateFromGlobalCommand: vi.fn(),
  repo: {activeWorkspaceId: 'ws-1'},
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/utils/navigation.ts', () => ({
  useNavigateFromGlobalCommand: () => mocks.navigateFromGlobalCommand,
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
})

describe('DailyNotePickerHeaderItem', () => {
  afterEach(() => {
    cleanup()
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
})
