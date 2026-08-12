// @vitest-environment happy-dom
/**
 * `writeTextToClipboard` / `writeTextToClipboardBestEffort` (`@/utils/copy.js`)
 * — the plain-text counterpart to `writeToClipboard`'s pending-move choke
 * point (see `copyClearsPendingMove.test.ts` for the rich-`ClipboardItem`
 * side). Every direct `navigator.clipboard.writeText` call site in the app
 * should route through one of these instead of calling the browser API
 * itself — block-move-ui review item 1: three bullet-menu copy actions
 * (`DefaultBlockRenderer.tsx`) bypassed the choke point entirely.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove'
import { writeTextToClipboard, writeTextToClipboardBestEffort } from '@/utils/copy'

const WS = 'ws-1'

afterEach(() => {
  clearPendingMove()
  vi.unstubAllGlobals()
})

describe('writeTextToClipboard', () => {
  it('clears a pending cut→move and writes the text', async () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await writeTextToClipboard('((b))')

    expect(getPendingMove()).toBeNull()
    expect(writeText).toHaveBeenCalledWith('((b))')
  })

  it('still clears the register even when the write itself is refused', async () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new DOMException('refused', 'NotAllowedError') }) },
    })

    await expect(writeTextToClipboard('((b))')).rejects.toThrow()

    expect(getPendingMove()).toBeNull()
  })

  it('propagates the failure to an awaiting/catching caller — same contract as a raw navigator.clipboard.writeText call', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new Error('boom') }) },
    })

    await expect(writeTextToClipboard('x')).rejects.toThrow('boom')
  })
})

describe('writeTextToClipboardBestEffort', () => {
  it('clears a pending cut→move and writes the text', () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    writeTextToClipboardBestEffort('((b))')

    expect(getPendingMove()).toBeNull()
    expect(writeText).toHaveBeenCalledWith('((b))')
  })

  // The clear is unconditional and synchronous — it must fire even when
  // there's no clipboard API to write to at all (non-secure context, or a
  // test environment, like this one, that never mocked
  // `navigator.clipboard`), which is exactly what makes this "best effort"
  // rather than the awaited `writeTextToClipboard` above.
  it('clears the pending move synchronously even with no clipboard API at all, and does not throw', () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    vi.stubGlobal('navigator', {})

    expect(() => writeTextToClipboardBestEffort('((b))')).not.toThrow()
    expect(getPendingMove()).toBeNull()
  })

  it('does not throw and does not surface an unhandled rejection when the write is refused', async () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new DOMException('refused', 'NotAllowedError') }) },
    })

    expect(() => writeTextToClipboardBestEffort('((b))')).not.toThrow()
    expect(getPendingMove()).toBeNull()
    // Let the swallowed rejection's microtask settle before the test ends —
    // if it weren't caught internally, this is where vitest would flag it.
    await new Promise(resolve => setTimeout(resolve, 0))
  })
})
