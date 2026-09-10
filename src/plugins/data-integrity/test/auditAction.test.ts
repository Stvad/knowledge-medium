// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The REAL dialogs module, driven through its real queue. Mocking it would mean
// the double reimplementing `isDialogOpenForWorkspace` — the very predicate the
// guard under test delegates to — so a broken guard would still pass. Seeding
// is a real `openDialog`; the assertions read the real queue.
vi.mock('@/plugins/data-integrity/schedule.js', () => ({
  runConsistencyAuditNow: vi.fn(),
}))
vi.mock('@/utils/toast.js', () => ({
  showError: vi.fn(),
  showProgress: vi.fn(),
}))
// Stub the dialog so importing the action doesn't pull its whole render graph;
// the guard compares Component identity, and both the action and this test see
// the SAME stub, so the identity match still holds.
vi.mock('../ConsistencyAuditDialog.tsx', () => ({
  ConsistencyAuditDialog: () => null,
}))

import { viewDataIntegrityAuditAction } from '../auditAction.ts'
import { ConsistencyAuditDialog } from '../ConsistencyAuditDialog.tsx'
import { getDialogQueue, openDialog } from '@/utils/dialogs.js'

/** The audit dialogs currently queued, by the workspace each is pinned to. */
const pinnedTo = (): Array<string | undefined> =>
  getDialogQueue()
    .filter((e) => (e.Component as unknown) === ConsistencyAuditDialog)
    .map((e) => e.props.workspaceId as string | undefined)

/** Seed "a dialog is already open, pinned to `workspaceId`". Never awaited — a
 *  queued dialog resolves only when something closes it, and nothing here does. */
const alreadyOpenFor = (workspaceId: string): void => {
  void openDialog(ConsistencyAuditDialog as never, { workspaceId } as never)
}

const invokeView = (activeWorkspaceId: string | null) =>
  // handler is (dependencies, trigger, dispatch?); this action only reads
  // dependencies.uiStateBlock, so the trigger is a throwaway.
  viewDataIntegrityAuditAction.handler(
    { uiStateBlock: { repo: { activeWorkspaceId } } } as never,
    {} as never,
  )

afterEach(() => {
  // Close whatever the test queued, so entries cannot leak into the next one.
  for (const entry of [...getDialogQueue()]) entry.finalize(null)
})

describe('view_data_integrity_audit action', () => {
  it('opens the results dialog pinned to the active workspace', () => {
    invokeView('ws-1')
    expect(pinnedTo()).toEqual(['ws-1'])
  })

  it('does not stack a second dialog already pinned to the active workspace', () => {
    alreadyOpenFor('ws-1')
    invokeView('ws-1')
    expect(pinnedTo()).toEqual(['ws-1'])
  })

  it('opens for the active workspace even if a dialog for a DIFFERENT one is open', () => {
    // The regression the exact-match guard fixes: a dialog pinned to ws-1 must NOT
    // suppress Inspect for ws-2 (previously an unpinned/self-pinned dialog would).
    alreadyOpenFor('ws-1')
    invokeView('ws-2')
    expect(pinnedTo()).toEqual(['ws-1', 'ws-2'])
  })
})
