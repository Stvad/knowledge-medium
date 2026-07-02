// @vitest-environment jsdom
/**
 * The on-demand audit results dialog. Covers the three UX contracts it owns:
 *   1. offending block ids are shown IN FULL and are copy-to-clipboard,
 *   2. clicking an id opens it in the SIDE PANEL (sidebar-stack) and KEEPS the
 *      dialog open (no resolve/cancel),
 *   3. it reads the LAST published result from the store, so it can be re-opened
 *      without re-running (empty state when nothing has run).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsistencyAuditResult } from '@/plugins/data-integrity/audit'
import {
  publishConsistencyAudit,
  resetConsistencyAuditStore,
} from '@/plugins/data-integrity/store'
import { ConsistencyAuditDialog } from '../ConsistencyAuditDialog.tsx'

const navigate = vi.fn()
const runConsistencyAuditNow = vi.fn()

vi.mock('@/utils/navigation.js', () => ({
  useNavigate: () => navigate,
}))
vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({ activeWorkspaceId: 'ws-1' }),
}))
vi.mock('@/plugins/data-integrity/schedule.js', () => ({
  runConsistencyAuditNow: (...args: unknown[]) => runConsistencyAuditNow(...args),
}))
vi.mock('@/utils/toast.js', () => ({
  showError: vi.fn(),
}))

const FULL_ID = '01234567-89ab-cdef-0123-456789abcdef'

const withSamples = (): ConsistencyAuditResult => ({
  workspaceId: 'ws-1',
  checkedAt: 1_700_000_000_000,
  anomalies: 1,
  checks: {
    references_index_mirror: {
      status: 'anomaly',
      missingIndexRows: 3,
      samples: [FULL_ID],
    },
  },
})

const renderDialog = (props: { workspaceId?: string } = {}) => {
  const resolve = vi.fn()
  const cancel = vi.fn()
  render(<ConsistencyAuditDialog resolve={resolve} cancel={cancel} {...props} />)
  return { resolve, cancel }
}

afterEach(() => {
  cleanup()
  resetConsistencyAuditStore()
  navigate.mockReset()
  runConsistencyAuditNow.mockReset()
})

describe('ConsistencyAuditDialog', () => {
  it('renders the FULL offending id (not truncated) from the store', () => {
    publishConsistencyAudit(withSamples())
    renderDialog()
    expect(screen.getByText(FULL_ID)).toBeTruthy()
  })

  it('copies the full id to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    publishConsistencyAudit(withSamples())
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Copy id' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FULL_ID))
  })

  it('opens a clicked id in the side panel WITHOUT closing the dialog', () => {
    publishConsistencyAudit(withSamples())
    const { resolve, cancel } = renderDialog()

    fireEvent.click(screen.getByText(FULL_ID))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: FULL_ID, target: 'sidebar-stack' }),
    )
    // The dialog must stay open so the (expensive) audit results aren't discarded.
    expect(resolve).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('shows an empty state (and no results) when nothing has run this session', () => {
    resetConsistencyAuditStore()
    renderDialog()
    expect(screen.getByText(/no audit has run/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /run audit/i })).toBeTruthy()
  })

  it('ignores a snapshot from a different workspace (treats it as empty)', () => {
    // Audit ran in another workspace; while ws-1 (the mocked active workspace) is
    // active, its counts/ids must NOT show — else a click would open a foreign id.
    publishConsistencyAudit({ ...withSamples(), workspaceId: 'ws-OTHER' })
    renderDialog()
    expect(screen.queryByText(FULL_ID)).toBeNull()
    expect(screen.getByRole('button', { name: /run audit/i })).toBeTruthy()
  })

  it('pins the audited workspace when opening a sample', () => {
    publishConsistencyAudit(withSamples())
    renderDialog()
    fireEvent.click(screen.getByText(FULL_ID))
    expect(navigate).toHaveBeenCalledWith({
      blockId: FULL_ID,
      target: 'sidebar-stack',
      workspaceId: 'ws-1',
    })
  })

  it('shows a pinned workspace’s results even when a different workspace is active', () => {
    // The run action audited ws-A; the user switched to ws-1 (active) before the
    // dialog opened. Pinning ws-A keeps its just-published result visible, and a
    // sample opens against ws-A — not the now-active ws-1.
    publishConsistencyAudit({ ...withSamples(), workspaceId: 'ws-A' })
    renderDialog({ workspaceId: 'ws-A' })
    expect(screen.getByText(FULL_ID)).toBeTruthy()
    fireEvent.click(screen.getByText(FULL_ID))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'sidebar-stack', workspaceId: 'ws-A' }),
    )
  })

  it('re-runs on demand via the store engine (updating in place)', async () => {
    runConsistencyAuditNow.mockResolvedValue(withSamples())
    publishConsistencyAudit(withSamples())
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: /re-run/i }))
    await waitFor(() => expect(runConsistencyAuditNow).toHaveBeenCalledWith(
      expect.objectContaining({ activeWorkspaceId: 'ws-1' }),
      'ws-1',
    ))
  })
})
