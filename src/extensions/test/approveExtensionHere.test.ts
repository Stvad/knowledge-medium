import {beforeEach, describe, expect, it, vi} from 'vitest'
import {approveExtensionHere} from '@/extensions/approveExtensionHere.js'
import type {Repo} from '@/data/repo'

const approveExtension = vi.hoisted(() => vi.fn())
const lookupApproval = vi.hoisted(() => vi.fn())
vi.mock('@/extensions/compileExtensionModule.js', () => ({approveExtension, lookupApproval, hashExtensionSource: async () => 'HASH'}))

const showError = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({showError}))

const makeRepo = (load: Repo['load']): Repo => ({load}) as unknown as Repo

const revision = {kind: 'needs-approval' as const, name: 'Ext', liveSource: 'SRC', liveHash: 'HASH'}
const pinExtensionImports = vi.hoisted(() => vi.fn())
vi.mock('@knowledge-medium/agent-cli/freezeExtensionImports', () => ({pinExtensionImports}))
vi.mock('@/facets/runtimeEvents.js', () => ({refreshAppRuntime: vi.fn()}))

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

    await expect(approveExtensionHere(repo, 'ext', revision)).resolves.toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(approveExtension).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('approval state'))
  })

  it('approves the block and returns true on success', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue({content: 'SRC'}))
    approveExtension.mockResolvedValue(undefined)

    await expect(approveExtensionHere(repo, 'ext', revision)).resolves.toBe(true)
    expect(approveExtension).toHaveBeenCalledWith('ext', 'SRC')
    expect(showError).not.toHaveBeenCalled()
  })

  it('declines an approval click after the displayed revision changed', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue({content: 'NEW'}))
    expect(await approveExtensionHere(repo, 'ext', revision)).toBe(false)
    expect(approveExtension).not.toHaveBeenCalled()
  })

  it('declines a revision whose displayed hash does not match its source', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue({content: 'SRC'}))
    expect(await approveExtensionHere(repo, 'ext', {...revision, liveHash: 'OTHER'})).toBe(false)
    expect(approveExtension).not.toHaveBeenCalled()
  })

  it.each(['SRC', 'edited during fetch'])('checks the current source inside the pin write transaction (%s)', async current => {
    const update = vi.fn()
    const tx = {get: async () => ({content: current}), update}
    const repo = {
      load: async () => ({content: 'SRC'}),
      tx: (write: (arg: typeof tx) => unknown) => write(tx),
    } as unknown as Repo
    pinExtensionImports.mockResolvedValue({source: 'PINNED', vendored: {}})
    expect(await approveExtensionHere(repo, 'ext', {...revision, kind: 'imports-unpinned'})).toBe(current === 'SRC')
    expect(pinExtensionImports).toHaveBeenCalledWith('SRC')
    if (current === 'SRC') {
      expect(update).toHaveBeenCalledWith('ext', {content: 'PINNED'})
      expect(approveExtension).toHaveBeenCalledWith('ext', 'PINNED', undefined, {})
    } else {
      expect(update).not.toHaveBeenCalled()
      expect(approveExtension).not.toHaveBeenCalled()
    }
  })

  it('refuses an already deleted definition with the same source', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue({content: 'SRC', deleted: true}))
    expect(await approveExtensionHere(repo, 'ext', revision)).toBe(false)
    expect(approveExtension).not.toHaveBeenCalled()
  })

  it('preserves a deletion during the pin fetch', async () => {
    const update = vi.fn()
    const tx = {get: async () => ({content: 'SRC', deleted: true}), update}
    const repo = {
      load: async () => ({content: 'SRC'}),
      tx: (write: (arg: typeof tx) => unknown) => write(tx),
    } as unknown as Repo
    pinExtensionImports.mockResolvedValue({source: 'PINNED', vendored: {}})
    expect(await approveExtensionHere(repo, 'ext', {...revision, kind: 'imports-unpinned'})).toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(approveExtension).not.toHaveBeenCalled()
  })

  it('returns false + toasts when the block is missing', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue(null))

    await expect(approveExtensionHere(repo, 'ext', revision)).resolves.toBe(false)
    expect(approveExtension).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith(expect.stringContaining("wasn't found"))
  })

  it('resolves false (never rejects) when the block LOAD itself fails', async () => {
    // A transient DB read error must be caught, not propagate — callers only
    // handle the resolved-false path.
    const repo = makeRepo(vi.fn().mockRejectedValue(new Error('IDB boom')))

    await expect(approveExtensionHere(repo, 'ext', revision)).resolves.toBe(false)
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('IDB boom'))
  })

  it('resolves false + toasts when the approval write fails', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue({content: 'SRC'}))
    approveExtension.mockRejectedValue(new Error('write rejected'))

    await expect(approveExtensionHere(repo, 'ext', revision)).resolves.toBe(false)
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('write rejected'))
  })
})
