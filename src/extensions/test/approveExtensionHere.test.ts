import {beforeEach, describe, expect, it, vi} from 'vitest'
import {approveExtensionHere} from '@/extensions/approveExtensionHere.js'
import type {Repo} from '@/data/repo'

const approveExtension = vi.hoisted(() => vi.fn())
vi.mock('@/extensions/compileExtensionModule.js', () => ({approveExtension}))

const showError = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({showError}))

const makeRepo = (load: Repo['load']): Repo => ({load}) as unknown as Repo

describe('approveExtensionHere', () => {
  beforeEach(() => vi.clearAllMocks())

  it('approves the block and returns true on success', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue({content: 'SRC'}))
    approveExtension.mockResolvedValue(undefined)

    await expect(approveExtensionHere(repo, 'ext', 'Ext')).resolves.toBe(true)
    expect(approveExtension).toHaveBeenCalledWith('ext', 'SRC')
    expect(showError).not.toHaveBeenCalled()
  })

  it('returns false + toasts when the block is missing', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue(null))

    await expect(approveExtensionHere(repo, 'ext', 'Ext')).resolves.toBe(false)
    expect(approveExtension).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith(expect.stringContaining("wasn't found"))
  })

  it('resolves false (never rejects) when the block LOAD itself fails', async () => {
    // A transient DB read error must be caught, not propagate — callers only
    // handle the resolved-false path.
    const repo = makeRepo(vi.fn().mockRejectedValue(new Error('IDB boom')))

    await expect(approveExtensionHere(repo, 'ext', 'Ext')).resolves.toBe(false)
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('IDB boom'))
  })

  it('resolves false + toasts when the approval write fails', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue({content: 'SRC'}))
    approveExtension.mockRejectedValue(new Error('write rejected'))

    await expect(approveExtensionHere(repo, 'ext', 'Ext')).resolves.toBe(false)
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('write rejected'))
  })
})
