// @vitest-environment happy-dom
/**
 * `AgentTokensDialog`'s "Copy" button for a freshly-minted token —
 * block-move-ui review item 1's "check for any other direct
 * navigator.clipboard.write* call site" sweep. It must clear a pending
 * cut→move the same way every other clipboard write does: this copy puts
 * DIFFERENT content on the clipboard than whatever was cut, so a pending
 * move left armed would let the next paste silently relocate the cut
 * blocks instead of pasting the token.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove.js'
import { AgentTokensDialog } from '../AgentTokensDialog.tsx'

vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({user: {id: 'user-1'}, activeWorkspaceId: 'ws-1'}),
}))

afterEach(() => {
  cleanup()
  clearPendingMove()
  localStorage.clear()
})

describe('AgentTokensDialog', () => {
  it('clears an unrelated pending cut→move when copying a freshly-minted token', async () => {
    setPendingMove({blockIds: ['other-block'], workspaceId: 'ws-1', clipboardText: 'other-block'})
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true})

    render(<AgentTokensDialog resolve={() => {}} cancel={() => {}}/>)

    fireEvent.change(screen.getByLabelText('New token label'), {target: {value: 'test-token'}})
    fireEvent.click(screen.getByRole('button', {name: 'Generate'}))

    const copyButton = await screen.findByRole('button', {name: 'Copy'})
    fireEvent.click(copyButton)

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(getPendingMove()).toBeNull()
  })
})
