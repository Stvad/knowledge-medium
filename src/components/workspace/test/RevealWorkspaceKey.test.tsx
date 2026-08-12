// @vitest-environment happy-dom
/**
 * `RevealWorkspaceKey`'s "Copy" button (the one-time e2ee workspace key,
 * shown once at creation) — block-move-ui review item 1's "check for any
 * other direct navigator.clipboard.write* call site" sweep. It must clear a
 * pending cut→move the same way every other clipboard write does: this copy
 * puts DIFFERENT content on the clipboard than whatever was cut, so a
 * pending move left armed would let the next paste silently relocate the
 * cut blocks instead of pasting the workspace key.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@/components/ui/dialog.js'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove.js'
import { RevealWorkspaceKey } from '../CreateWorkspaceDialog.tsx'

afterEach(() => {
  cleanup()
  clearPendingMove()
})

describe('RevealWorkspaceKey', () => {
  it('clears an unrelated pending cut→move when copying the workspace key', async () => {
    setPendingMove({blockIds: ['other-block'], workspaceId: 'ws-1', clipboardText: 'other-block'})
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true})

    render(
      <Dialog open>
        <DialogContent>
          <RevealWorkspaceKey workspaceKey="WK-secret-key-value" onConfirm={() => {}}/>
        </DialogContent>
      </Dialog>,
    )

    fireEvent.click(screen.getByRole('button', {name: 'Copy'}))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('WK-secret-key-value'))
    expect(getPendingMove()).toBeNull()
  })
})
