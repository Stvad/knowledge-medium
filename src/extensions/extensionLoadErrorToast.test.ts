import { describe, expect, it, vi, beforeEach } from 'vitest'
import { toastExtensionLoadError } from './extensionLoadErrorToast.ts'

vi.mock('@/utils/toast.js', () => ({ showError: vi.fn() }))
vi.mock('@/shortcuts/runAction.js', () => ({ runActionById: vi.fn() }))
const { showError } = await import('@/utils/toast.js')
const { runActionById } = await import('@/shortcuts/runAction.js')

describe('toastExtensionLoadError', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows an error toast carrying the failure message the first time a key is seen', () => {
    const seen = new Set<string>()
    const shown = toastExtensionLoadError(seen, 'ws:blk', 'blk', new Error('boom'))

    expect(shown).toBe(true)
    expect(showError).toHaveBeenCalledOnce()
    const [message, opts] = vi.mocked(showError).mock.calls[0]!
    expect(message).toContain('boom')
    // Stable per-block id so a later re-fire updates in place, not stacks.
    expect(opts?.id).toBe('extension-load-error:blk')
  })

  it('suppresses a repeat toast for the same key', () => {
    const seen = new Set<string>()
    toastExtensionLoadError(seen, 'ws:blk', 'blk', new Error('boom'))
    const second = toastExtensionLoadError(seen, 'ws:blk', 'blk', new Error('boom again'))

    expect(second).toBe(false)
    expect(showError).toHaveBeenCalledOnce()
  })

  it('toasts again for a different key (another block or workspace)', () => {
    const seen = new Set<string>()
    toastExtensionLoadError(seen, 'ws:blk1', 'blk1', new Error('a'))
    toastExtensionLoadError(seen, 'ws:blk2', 'blk2', new Error('b'))

    expect(showError).toHaveBeenCalledTimes(2)
  })

  it('the toast action opens Extensions settings', () => {
    const seen = new Set<string>()
    toastExtensionLoadError(seen, 'ws:blk', 'blk', new Error('boom'))

    const [, opts] = vi.mocked(showError).mock.calls[0]!
    opts!.action!.onClick()

    expect(runActionById).toHaveBeenCalledWith(
      'open_extensions_settings',
      expect.anything(),
    )
  })
})
