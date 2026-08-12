// @vitest-environment happy-dom
/**
 * `RejectionDialog`'s "Copy" button (payload + error, for reporting a
 * quarantined sync change) — block-move-ui review item 1's "check for any
 * other direct navigator.clipboard.write* call site" sweep. It must clear a
 * pending cut→move the same way every other clipboard write does: this copy
 * puts DIFFERENT content on the clipboard than whatever was cut, so a
 * pending move left armed would let the next paste silently relocate the
 * cut blocks instead of pasting the row's payload.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove.js'
import { RejectionDialog } from '../RejectionDialog.tsx'

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}))

vi.mock('@powersync/react', () => ({
  usePowerSync: () => ({execute: vi.fn(), writeTransaction: vi.fn()}),
  useQuery: (sql: string) => ({
    data: sql.includes('ps_crud_rejected') ? mocks.rows : [],
    isLoading: false,
  }),
}))

afterEach(() => {
  cleanup()
  clearPendingMove()
  mocks.rows = []
})

describe('RejectionDialog', () => {
  it('clears an unrelated pending cut→move when copying a rejected row', async () => {
    mocks.rows = [{
      id: 1,
      original_id: 1,
      tx_id: 5,
      data: '{}',
      error_code: 'CONSTRAINT',
      error_message: null,
      rejected_at: Date.now(),
    }]
    setPendingMove({blockIds: ['other-block'], workspaceId: 'ws-1', clipboardText: 'other-block'})
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true})

    render(<RejectionDialog open onOpenChange={() => {}}/>)

    fireEvent.click(screen.getByRole('button', {name: 'Copy'}))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(getPendingMove()).toBeNull()
  })
})
