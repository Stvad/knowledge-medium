// @vitest-environment happy-dom
/**
 * ReceiptToast is the one live reactive consumer of the UndoManager
 * (port of the old RescheduleToast test, issue #186). The inverse-gesture
 * button tracks the undo/redo stack of ITS receipt's workspace and must
 * mirror exactly what `repo.undo()` / `repo.redo()` will do: enabled only
 * while `revert.entry` is the top of the matching stack of `revert.workspaceId`
 * AND that workspace is active, and it re-checks at click time because an
 * in-place workspace switch doesn't re-notify undo subscribers.
 *
 * Unlike the old groupId match, the new component matches by ENTRY
 * IDENTITY (`peekUndo`/`peekRedo` === `revert.entry`) — merging is the
 * UndoManager's job now, not the toast's.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import type { BlockData, Handle, HandleStatus } from '@/data/api'
import { UndoManager, type UndoEntry } from '@/data/internals/undoManager'
import { newSnapshotsMap } from '@/data/internals/txSnapshots'
import { makeBlockData } from '@/data/test/factories'
import type { Repo } from '@/data/repo'
import type { Receipt, ReceiptSubject } from './facet.ts'
import { ledgerOpen, type ShownReceipt } from './receipts.ts'
import { ReceiptToast, EmptyReceiptToast } from './ReceiptToast.tsx'

const { dismissToastMock, showErrorMock, navigateFromGlobalCommandMock } = vi.hoisted(() => ({
  dismissToastMock: vi.fn(),
  showErrorMock: vi.fn(),
  navigateFromGlobalCommandMock: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/utils/toast.js', () => ({
  dismissToast: dismissToastMock,
  showError: showErrorMock,
  showInfo: vi.fn(),
  showCustom: vi.fn(),
}))
vi.mock('@/utils/navigation.js', () => ({
  navigateFromGlobalCommand: navigateFromGlobalCommandMock,
}))

const makeEntry = (txId: string): UndoEntry => {
  const snapshots = newSnapshotsMap()
  snapshots.set('a', {before: null, after: makeBlockData({id: 'a', workspaceId: 'ws-1'})})
  return {txId, scope: ChangeScope.BlockDefault, snapshots}
}

/** A minimal `Handle` stand-in for `repo.block(id)`. Peek()'s value never
 *  changes and subscribe() is a no-op — enough for `useHandle`'s
 *  status/load/peek/subscribe calls, since these tests don't exercise the
 *  live-load path. */
const stubBlockHandle = (data?: BlockData): Handle<BlockData | null> => ({
  key: 'stub-block',
  peek: () => data ?? undefined,
  status: (): HandleStatus => 'ready',
  load: () => Promise.resolve(data ?? null),
  read: () => data ?? null,
  subscribe: () => () => {},
})

// Minimal Repo stand-in: the toast reads `activeWorkspaceId`, `undoManager`
// / `undoManagerFor`, calls `undo()` / `redo()`, and (for a subject) reads
// `block(id)`. `undoManagerFor` returns the SAME manager regardless of
// workspace id — the gate's `activeWorkspaceId === revert.workspaceId`
// check means the manager is only ever consulted for `ws-1`, so a single
// manager suffices (same rationale as the old RescheduleToast test).
// `activeWorkspaceId` is a getter so a test can flip it post-render
// WITHOUT a re-render (simulating an in-place workspace switch — exactly
// the reactivity gap the click-time handler guards).
const makeRepo = (
  undoManager: UndoManager,
  active: {id: string | null},
  opts: {
    undo?: ReturnType<typeof vi.fn>
    redo?: ReturnType<typeof vi.fn>
    block?: (id: string) => Handle<BlockData | null>
    exists?: boolean
  } = {},
): Repo =>
  ({
    undoManager,
    undoManagerFor: () => undoManager,
    get activeWorkspaceId() { return active.id },
    undo: opts.undo ?? vi.fn().mockResolvedValue(true),
    redo: opts.redo ?? vi.fn().mockResolvedValue(true),
    block: opts.block ?? (() => stubBlockHandle()),
    exists: vi.fn().mockResolvedValue(opts.exists ?? true),
  } as unknown as Repo)

const makeSubject = (overrides: Partial<ReceiptSubject> = {}): ReceiptSubject => ({
  id: 'block-1',
  workspaceId: 'ws-1',
  label: 'Fallback label',
  labelIsContent: false,
  kind: 'content',
  navigable: true,
  ...overrides,
})

const undoOrRedoButton = () => screen.getByRole('button', {name: /^(Undo|Redo)/}) as HTMLButtonElement

const renderToast = (shown: ShownReceipt, repo: Repo) =>
  render(<ReceiptToast toastId="toast-1" shown={shown} repo={repo} />)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  ledgerOpen.close()
})

describe('ReceiptToast inverse-gesture liveness (#186, entry identity)', () => {
  it('enables Undo and reverts when the entry is top of the active workspace undo stack', () => {
    const m = new UndoManager()
    const entry = makeEntry('t1')
    m.record(entry)
    const undo = vi.fn().mockResolvedValue(true)
    const receipt: Receipt = {
      key: 'reschedule',
      verb: 'Rescheduled',
      revert: {direction: 'undo', entry, workspaceId: 'ws-1'},
    }
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(m, {id: 'ws-1'}, {undo}))

    const btn = undoOrRedoButton()
    expect(btn.disabled).toBe(false)

    fireEvent.click(btn)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(undo).toHaveBeenCalledWith(ChangeScope.BlockDefault)
    expect(dismissToastMock).toHaveBeenCalledWith('toast-1')
  })

  it('disables Undo while viewing a different workspace than the revert', () => {
    const m = new UndoManager()
    const entry = makeEntry('t1')
    m.record(entry)
    const receipt: Receipt = {
      key: 'reschedule',
      verb: 'Rescheduled',
      revert: {direction: 'undo', entry, workspaceId: 'ws-1'},
    }
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(m, {id: 'ws-2'}))
    // ws-1's entry exists, but ws-2 is active — repo.undo() would not
    // revert it, so the button must not claim it can.
    expect(undoOrRedoButton().disabled).toBe(true)
  })

  it('does NOT revert a different workspace if the active workspace changed after render', () => {
    const m = new UndoManager()
    const entry = makeEntry('t1')
    m.record(entry)
    const active = {id: 'ws-1'}
    const undo = vi.fn().mockResolvedValue(true)
    const receipt: Receipt = {
      key: 'reschedule',
      verb: 'Rescheduled',
      revert: {direction: 'undo', entry, workspaceId: 'ws-1'},
    }
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(m, active, {undo}))

    const btn = undoOrRedoButton()
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

  it('disables Undo once a foreign entry lands on top of the stack', () => {
    const m = new UndoManager()
    const entry = makeEntry('t1')
    m.record(entry)
    const receipt: Receipt = {
      key: 'reschedule',
      verb: 'Rescheduled',
      revert: {direction: 'undo', entry, workspaceId: 'ws-1'},
    }
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(m, {id: 'ws-1'}))
    expect(undoOrRedoButton().disabled).toBe(false)

    // A later edit in ws-1 pushes a foreign entry on top; the
    // subscribe-driven re-render must disable the button. Wrap the
    // external-store mutation in act() so React flushes the notify.
    act(() => { m.record(makeEntry('t2')) })
    expect(undoOrRedoButton().disabled).toBe(true)
  })

  it('enables Redo while the entry is top of the redo stack, and disables once it clears', () => {
    const m = new UndoManager()
    const entry = makeEntry('t1')
    m.pushRedo(ChangeScope.BlockDefault, entry)
    const redo = vi.fn().mockResolvedValue(true)
    const receipt: Receipt = {
      key: 'redo',
      verb: 'Redid',
      revert: {direction: 'redo', entry, workspaceId: 'ws-1'},
    }
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(m, {id: 'ws-1'}, {redo}))

    const btn = screen.getByRole('button', {name: /^Redo/}) as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    fireEvent.click(btn)
    expect(redo).toHaveBeenCalledTimes(1)
    expect(redo).toHaveBeenCalledWith(ChangeScope.BlockDefault)

    // `record` clears the redo stack for the scope (a fresh action
    // invalidates the redo branch) — a foreign undo push must disable it.
  })

  it('disables Redo once a later record clears the redo stack', () => {
    const m = new UndoManager()
    const entry = makeEntry('t1')
    m.pushRedo(ChangeScope.BlockDefault, entry)
    const receipt: Receipt = {
      key: 'redo',
      verb: 'Redid',
      revert: {direction: 'redo', entry, workspaceId: 'ws-1'},
    }
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(m, {id: 'ws-1'}))
    expect(screen.getByRole('button', {name: /^Redo/}).getAttribute('disabled')).toBeNull()

    act(() => { m.record(makeEntry('t2')) })
    expect((screen.getByRole('button', {name: /^Redo/}) as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces an undo rejection via showError', async () => {
    const m = new UndoManager()
    const entry = makeEntry('t1')
    m.record(entry)
    const undo = vi.fn().mockRejectedValue(new Error('sync conflict'))
    const receipt: Receipt = {
      key: 'reschedule',
      verb: 'Rescheduled',
      revert: {direction: 'undo', entry, workspaceId: 'ws-1'},
    }
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(m, {id: 'ws-1'}, {undo}))

    fireEvent.click(undoOrRedoButton())
    expect(dismissToastMock).toHaveBeenCalledWith('toast-1')

    await vi.waitFor(() => {
      expect(showErrorMock).toHaveBeenCalledWith('sync conflict')
    })
  })
})

describe('ReceiptToast Go to', () => {
  it('navigates to the subject and dismisses the toast', async () => {
    const subject = makeSubject({id: 'block-1', workspaceId: 'ws-1'})
    const receipt: Receipt = {key: 'move', verb: 'Moved', subject}
    const repo = makeRepo(new UndoManager(), {id: 'ws-1'})
    renderToast({receipt, count: 1, offscreen: true}, repo)

    fireEvent.click(screen.getByRole('button', {name: 'Go to'}))

    await vi.waitFor(() => {
      expect(navigateFromGlobalCommandMock).toHaveBeenCalledWith(repo, {blockId: 'block-1', workspaceId: 'ws-1'})
    })
    expect(dismissToastMock).toHaveBeenCalledWith('toast-1')
  })

  it('does not navigate onto a block deleted since the receipt', async () => {
    const subject = makeSubject({id: 'block-1', workspaceId: 'ws-1'})
    const receipt: Receipt = {key: 'move', verb: 'Moved', subject}
    const repo = makeRepo(new UndoManager(), {id: 'ws-1'}, {exists: false})
    renderToast({receipt, count: 1, offscreen: true}, repo)

    fireEvent.click(screen.getByRole('button', {name: 'Go to'}))

    await vi.waitFor(() => { expect(repo.exists).toHaveBeenCalledWith('block-1') })
    expect(navigateFromGlobalCommandMock).not.toHaveBeenCalled()
  })

  it('does not render Go to for a subject in another workspace', () => {
    const subject = makeSubject({id: 'block-1', workspaceId: 'ws-2'})
    const receipt: Receipt = {key: 'move', verb: 'Moved', subject}
    renderToast({receipt, count: 1, offscreen: true}, makeRepo(new UndoManager(), {id: 'ws-1'}))

    expect(screen.queryByRole('button', {name: 'Go to'})).toBeNull()
  })

  it('does not render Go to when the subject is not offscreen', () => {
    const subject = makeSubject({id: 'block-1', workspaceId: 'ws-1'})
    const receipt: Receipt = {key: 'move', verb: 'Moved', subject}
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(new UndoManager(), {id: 'ws-1'}))

    expect(screen.queryByRole('button', {name: 'Go to'})).toBeNull()
  })
})

describe('ReceiptToast ledger', () => {
  it('opens the ledger via the history button and dismisses the toast', () => {
    const receipt: Receipt = {key: 'delete', verb: 'Deleted'}
    expect(ledgerOpen.isOpen()).toBe(false)
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(new UndoManager(), {id: 'ws-1'}))

    fireEvent.click(screen.getByRole('button', {name: 'Recent actions'}))

    expect(ledgerOpen.isOpen()).toBe(true)
    expect(dismissToastMock).toHaveBeenCalledWith('toast-1')
  })
})

describe('EmptyReceiptToast', () => {
  it('renders just the verb and hint, with no buttons', () => {
    render(<EmptyReceiptToast verb="Nothing to undo" hint="⌘Z has nothing to do" />)

    expect(screen.getByText('Nothing to undo')).toBeInTheDocument()
    expect(screen.getByText('⌘Z has nothing to do')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('ReceiptToast subject label', () => {
  it('falls back to the receipt label while the live block has not resolved', () => {
    const subject = makeSubject({label: 'Reschedule this task'})
    const receipt: Receipt = {key: 'reschedule', verb: 'Rescheduled', subject}
    const repo = makeRepo(new UndoManager(), {id: 'ws-1'}, {block: () => stubBlockHandle(undefined)})
    renderToast({receipt, count: 1, offscreen: false}, repo)

    expect(screen.getByText('Reschedule this task')).toBeInTheDocument()
  })
})

describe('ReceiptToast folded presses', () => {
  it('shows the latest receipt in full with a +N chip for the earlier ones', () => {
    const subject = makeSubject({label: 'Third block'})
    const receipt: Receipt = {key: 'undo', history: 'undo', verb: 'Undid edit', subject}
    renderToast({receipt, count: 3, offscreen: false}, makeRepo(new UndoManager(), {id: 'ws-1'}))

    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('Undid edit')).toBeInTheDocument()
    expect(screen.getByText('Third block')).toBeInTheDocument()
  })

  it('shows no chip for a single press', () => {
    const receipt: Receipt = {key: 'undo', history: 'undo', verb: 'Undid edit'}
    renderToast({receipt, count: 1, offscreen: false}, makeRepo(new UndoManager(), {id: 'ws-1'}))

    expect(screen.queryByText(/^\+\d/)).toBeNull()
  })
})
