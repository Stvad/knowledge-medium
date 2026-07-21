// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DailyNotePicker, type DailyNotePickerProps } from '../DailyNotePicker.tsx'
import { DailyNotePickerHeaderItem } from '../HeaderItem.tsx'
import { openDialog } from '@/utils/dialogs.js'
import {
  OPEN_NEXT_DAILY_NOTE_ACTION_ID,
  OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
} from '../actions.ts'

const mocks = vi.hoisted(() => ({
  getOrCreateDailyNote: vi.fn(async (_repo: unknown, _workspaceId: string, iso: string) => ({
    id: `daily-${iso}`,
  })),
  openBlock: vi.fn(),
  repo: {activeWorkspaceId: 'ws-1'},
  resolveCurrentDailyNoteIso: vi.fn<(_repo: unknown, _workspaceId: string) => Promise<string | null>>(async () => null),
  runAction: vi.fn(),
}))

vi.mock('@/utils/dialogs.js', () => ({ openDialog: vi.fn() }))

const openDialogMock = vi.mocked(openDialog)

/** Render the picker as `openDialog` would — with props + finalize
 *  callbacks. Returns the spies so tests can assert resolve/cancel. */
const renderPicker = (props: Partial<DailyNotePickerProps> = {}) => {
  const resolve = vi.fn()
  const cancel = vi.fn()
  render(<DailyNotePicker resolve={resolve} cancel={cancel} {...props} />)
  return {resolve, cancel}
}

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/utils/navigation.ts', () => ({
  useBlockOpener: () => mocks.openBlock,
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

vi.mock('../actions.ts', async () => {
  const actual = await vi.importActual<typeof import('../actions.ts')>('../actions.ts')
  return {
    ...actual,
    resolveCurrentDailyNoteIso: mocks.resolveCurrentDailyNoteIso,
  }
})

describe('DailyNotePicker', () => {
  beforeAll(() => {
    // Pin "today" so the highlight assertions are stable across calendar
    // dates. The picker reads `new Date()` via `todayIso()` for the
    // today-highlight cell. Only fake Date — leaving setTimeout/Interval
    // real so React Testing Library's `waitFor` can still poll.
    vi.useFakeTimers({toFake: ['Date']})
    vi.setSystemTime(new Date(2026, 4, 15, 12))
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    cleanup()
    mocks.getOrCreateDailyNote.mockClear()
    mocks.openBlock.mockClear()
    mocks.runAction.mockClear()
    openDialogMock.mockClear()
  })

  it('opens to the initial ISO month and highlights both today and the selected day', () => {
    renderPicker({initialIso: '2026-03-21'})

    const dialog = screen.getByRole('dialog', {name: 'Daily note picker'})
    expect(dialog.textContent).toContain('March')
    expect(dialog.textContent).toContain('2026')

    // No `current` cell when today isn't in the visible month — but
    // navigate forward two months and today (May 15) should be marked.
    expect(dialog.querySelector('[aria-current="date"]')).toBeNull()

    // The selected day is the only cell with the destructive background.
    const selected = screen.getByRole('button', {name: 'March 21, 2026'})
    expect(selected.className).toContain('bg-destructive')
  })

  it('highlights today alongside the selected day when both are visible', () => {
    renderPicker({initialIso: '2026-05-04'})

    const dialog = screen.getByRole('dialog', {name: 'Daily note picker'})
    expect(dialog.textContent).toContain('May')

    const today = screen.getByRole('button', {name: 'May 15, 2026'})
    expect(today.getAttribute('aria-current')).toBe('date')
    expect(today.className).toContain('text-destructive')

    const selected = screen.getByRole('button', {name: 'May 4, 2026'})
    expect(selected.className).toContain('bg-destructive')
    expect(selected.getAttribute('aria-current')).toBeNull()
  })

  it('forwards the picked day to the block opener and resolves', async () => {
    const {resolve} = renderPicker({initialIso: '2026-05-13'})

    expect(screen.getByRole('dialog', {name: 'Daily note picker'})).toBeTruthy()

    fireEvent.click(screen.getByRole('button', {name: 'May 13, 2026'}))

    await waitFor(() => {
      expect(mocks.getOrCreateDailyNote).toHaveBeenCalledExactlyOnceWith(
        mocks.repo,
        'ws-1',
        '2026-05-13',
      )
    })
    expect(mocks.openBlock).toHaveBeenCalledOnce()
    const [, ctx] = mocks.openBlock.mock.calls[0]
    expect(ctx).toEqual({blockId: 'daily-2026-05-13', workspaceId: 'ws-1'})
    await waitFor(() => expect(resolve).toHaveBeenCalled())
  })

  it('forwards shift-click through the block opener for sidebar-stack routing', async () => {
    const {resolve} = renderPicker({initialIso: '2026-05-13'})

    fireEvent.click(screen.getByRole('button', {name: 'May 13, 2026'}), {
      button: 0,
      shiftKey: true,
    })

    await waitFor(() => {
      expect(mocks.getOrCreateDailyNote).toHaveBeenCalledExactlyOnceWith(
        mocks.repo,
        'ws-1',
        '2026-05-13',
      )
    })
    expect(mocks.openBlock).toHaveBeenCalledOnce()
    const [event, ctx] = mocks.openBlock.mock.calls[0]
    expect(event.shiftKey).toBe(true)
    expect(ctx).toEqual({blockId: 'daily-2026-05-13', workspaceId: 'ws-1'})
    await waitFor(() => expect(resolve).toHaveBeenCalled())
  })

  it('lays out the calendar week from Monday', () => {
    renderPicker({initialIso: '2026-05-13'})

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
    mocks.resolveCurrentDailyNoteIso.mockClear()
    mocks.resolveCurrentDailyNoteIso.mockImplementation(async () => null)
    openDialogMock.mockClear()
  })

  it('opens the picker dialog from the header button', async () => {
    render(<DailyNotePickerHeaderItem/>)
    fireEvent.click(screen.getByRole('button', {name: 'Open daily note picker'}))

    await waitFor(() => {
      expect(openDialogMock).toHaveBeenCalledOnce()
    })
    const props = openDialogMock.mock.calls[0][1] as DailyNotePickerProps
    expect(props.anchorRect).toBeTruthy()
    expect(props.initialIso).toBeUndefined()
  })

  it('passes the currently viewed daily note ISO when opening', async () => {
    mocks.resolveCurrentDailyNoteIso.mockImplementation(async () => '2026-03-21')

    render(<DailyNotePickerHeaderItem/>)
    fireEvent.click(screen.getByRole('button', {name: 'Open daily note picker'}))

    await waitFor(() => {
      expect(openDialogMock).toHaveBeenCalledOnce()
    })
    const props = openDialogMock.mock.calls[0][1] as DailyNotePickerProps
    expect(props.initialIso).toBe('2026-03-21')
    expect(mocks.resolveCurrentDailyNoteIso).toHaveBeenCalledWith(mocks.repo, 'ws-1')
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
