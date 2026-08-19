import {beforeEach, describe, expect, it, vi} from 'vitest'
import {approveExtensionHere} from '@/extensions/approveExtensionHere.js'
import type {Repo} from '@/data/repo'

const approveExtension = vi.hoisted(() => vi.fn())
const lookupApproval = vi.hoisted(() => vi.fn())
vi.mock('@/extensions/compileExtensionModule.js', () => ({approveExtension, lookupApproval}))

const showError = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({showError}))

const makeRepo = (load: Repo['load']): Repo => ({load}) as unknown as Repo

describe('approveExtensionHere', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: the approval store is readable (no existing pin to protect).
    lookupApproval.mockResolvedValue({status: 'unapproved'})
  })

  it('fails closed (no load, no approve) when the approval store is unreadable', async () => {
    // A transient approval-read failure surfaces as needs-approval; approving
    // now could clobber an existing trusted pin, so bail out (#67).
    lookupApproval.mockResolvedValue({status: 'unreadable'})
    const load = vi.fn()
    const repo = makeRepo(load)

    await expect(approveExtensionHere(repo, 'ext', 'Ext')).resolves.toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(approveExtension).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('approval state'))
  })

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
