// @vitest-environment jsdom
/**
 * RescheduleToast is the one live reactive consumer of the UndoManager.
 * Undo is workspace-scoped (issue #186), so the toast's Undo button must
 * track the reschedule's OWN workspace and mirror exactly what
 * `repo.undo()` will do — never claim it can undo while the user is
 * looking at a different workspace, and never revert a different
 * workspace's entry if the active workspace changed since render (an
 * in-place switch doesn't re-notify undo subscribers).
 *
 * Since issue #306 the reschedule records ONE grouped entry, so the
 * toast matches the top of stack by `groupId` (not `txId`) — later txs
 * that MERGE into the same group keep the toast's Undo valid, while any
 * foreign entry on top disables it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import { UndoManager } from '@/data/internals/undoManager'
import { newSnapshotsMap } from '@/data/internals/txSnapshots'
import { makeBlockData } from '@/data/test/factories'
import type { Repo } from '@/data/repo'
import { RescheduleToast } from '../RescheduleToast.tsx'

const { dismissToastMock, showErrorMock } = vi.hoisted(() => ({
  dismissToastMock: vi.fn(),
  showErrorMock: vi.fn(),
}))
vi.mock('@/utils/toast.js', () => ({
  dismissToast: dismissToastMock,
  showError: showErrorMock,
}))

const makeEntry = (txId: string, groupId?: string) => {
  const snapshots = newSnapshotsMap()
  snapshots.set('a', {before: null, after: makeBlockData({id: 'a', workspaceId: 'ws-1'})})
  return {txId, scope: ChangeScope.BlockDefault, snapshots, groupId}
}

// Minimal Repo stand-in: the toast only reads `activeWorkspaceId`,
// `undoManager`, and calls `undo()`. `undoManager` here stands in for the
// ACTIVE workspace's manager (per-workspace registry, issue #186); the
// gate's `activeWorkspaceId === workspaceId` check means `peekUndo` is only
// consulted while ws-1 is active, so a single manager suffices.
// `activeWorkspaceId` is a getter so a test can flip it post-render WITHOUT
// a re-render (simulating an in-place workspace switch — exactly the
// reactivity gap the click-time handler guards).
const makeRepo = (
  undoManager: UndoManager,
  active: { id: string | null },
  undo = vi.fn().mockResolvedValue(true),
): Repo =>
  ({
    undoManager,
    get activeWorkspaceId() { return active.id },
    undo,
  } as unknown as Repo)

const undoButton = () => screen.getByRole('button', {name: 'Undo'}) as HTMLButtonElement

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RescheduleToast workspace scoping (#186)', () => {
  it('enables Undo and reverts when the reschedule is the active workspace top', () => {
    const m = new UndoManager()
    m.record(makeEntry('t1', 'g1'))
    const undo = vi.fn().mockResolvedValue(true)
    render(
      <RescheduleToast
        toastId="toast-1"
        message="Rescheduled"
        groupId="g1"
        workspaceId="ws-1"
        repo={makeRepo(m, {id: 'ws-1'}, undo)}
      />,
    )

    const btn = undoButton()
    expect(btn.disabled).toBe(false)

    fireEvent.click(btn)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(dismissToastMock).toHaveBeenCalledWith('toast-1')
  })

  it('disables Undo while viewing a different workspace than the reschedule', () => {
    const m = new UndoManager()
    m.record(makeEntry('t1', 'g1'))
    render(
      <RescheduleToast
        toastId="toast-1"
        message="Rescheduled"
        groupId="g1"
        workspaceId="ws-1"
        repo={makeRepo(m, {id: 'ws-2'})}
      />,
    )
    // ws-1's entry exists, but ws-2 is active — repo.undo() would not
    // revert it, so the button must not claim it can.
    expect(undoButton().disabled).toBe(true)
  })

  it('does NOT revert a different workspace if the active workspace changed after render', () => {
    const m = new UndoManager()
    m.record(makeEntry('t1', 'g1'))
    const active = {id: 'ws-1'}
    const undo = vi.fn().mockResolvedValue(true)
    render(
      <RescheduleToast
        toastId="toast-1"
        message="Rescheduled"
        groupId="g1"
        workspaceId="ws-1"
        repo={makeRepo(m, active, undo)}
      />,
    )

    const btn = undoButton()
    expect(btn.disabled).toBe(false) // rendered while ws-1 active

    // In-place switch to ws-2 — no undo-stack change, so the toast does
    // not re-render and the button is still visually enabled.
    active.id = 'ws-2'
    fireEvent.click(btn)

    // The click-time re-check catches the stale state: undo is NOT called
    // (which would have reverted ws-2's top instead), and the toast just
    // dismisses.
    expect(undo).not.toHaveBeenCalled()
    expect(dismissToastMock).toHaveBeenCalledWith('toast-1')
  })

  it('disables Undo once a foreign entry lands on the reschedule workspace', () => {
    const m = new UndoManager()
    m.record(makeEntry('t1', 'g1'))
    render(
      <RescheduleToast
        toastId="toast-1"
        message="Rescheduled"
        groupId="g1"
        workspaceId="ws-1"
        repo={makeRepo(m, {id: 'ws-1'})}
      />,
    )
    expect(undoButton().disabled).toBe(false)

    // A later edit in ws-1 makes the reschedule no longer the top; the
    // subscribe-driven re-render must disable the button. Wrap the
    // external-store mutation in act() so React flushes the notify.
    act(() => { m.record(makeEntry('t2')) })
    expect(undoButton().disabled).toBe(true)
  })

  it('stays enabled when a same-group tx merges into the reschedule entry (#306)', () => {
    const m = new UndoManager()
    m.record(makeEntry('t1', 'g1'))
    render(
      <RescheduleToast
        toastId="toast-1"
        message="Rescheduled"
        groupId="g1"
        workspaceId="ws-1"
        repo={makeRepo(m, {id: 'ws-1'})}
      />,
    )
    expect(undoButton().disabled).toBe(false)

    // A trailing grouped tx (e.g. the reschedule's own property write
    // landing after the daily-note creations) merges into the same
    // entry — undoing it still reverts exactly this reschedule.
    act(() => { m.record({...makeEntry('t2', 'g1'), steps: [{txId: 't2'}]}) })
    expect(undoButton().disabled).toBe(false)
  })
})
