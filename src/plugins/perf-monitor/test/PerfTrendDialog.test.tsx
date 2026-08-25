// @vitest-environment happy-dom
/**
 * The dialog is pinned to the workspace it opened on, but a fresh analysis
 * reads AMBIENT state — `repo.isReadOnly` describes whichever workspace is
 * active now, not the pinned one.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerfTrendDialog } from '../PerfTrendDialog.tsx'

const mocks = vi.hoisted(() => ({
  repo: {
    activeWorkspaceId: 'ws-A',
    user: { id: 'user-1', name: 'Alice' },
    db: { getAll: async () => [] as unknown[] },
  },
  runNow: vi.fn(async () => {}),
}))

vi.mock('@/context/repo.tsx', () => ({ useRepo: () => mocks.repo }))
vi.mock('../schedule.ts', () => ({ runPerfAnalysisNow: mocks.runNow }))

afterEach(() => {
  vi.clearAllMocks()
  mocks.repo.activeWorkspaceId = 'ws-A'
})

const reanalyze = () => screen.getByRole('button', { name: /re-analyze/i })

describe('PerfTrendDialog', () => {
  it('offers re-analysis for the workspace it is pinned to', async () => {
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId="ws-A" />)
    await waitFor(() => expect(reanalyze()).toBeEnabled())
  })

  // Analyzing the pinned workspace from inside another reports the ACTIVE
  // workspace's blocker as the pinned one's: an editable workspace shown as
  // recording-disabled, or a read-only one shown as fine.
  it('refuses re-analysis once the active workspace has moved on', async () => {
    mocks.repo.activeWorkspaceId = 'ws-B'
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId="ws-A" />)

    await waitFor(() => expect(reanalyze()).toBeDisabled())
    expect(screen.getByText(/switched workspace/i)).toBeInTheDocument()
    expect(mocks.runNow).not.toHaveBeenCalled()
  })
})
