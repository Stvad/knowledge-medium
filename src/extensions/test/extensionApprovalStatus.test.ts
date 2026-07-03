import {describe, expect, it, vi} from 'vitest'
import {ExtensionApprovalStatusStore} from '@/extensions/extensionApprovalStatus.js'
import type {ExtensionApprovalStatus} from '@/extensions/dynamicExtensions.js'

const needsApproval = (name: string, liveHash: string): ExtensionApprovalStatus => ({
  kind: 'needs-approval',
  name,
  liveHash,
})

describe('ExtensionApprovalStatusStore — batching', () => {
  it('buffers reports with no notify until commit, then swaps atomically', () => {
    const store = new ExtensionApprovalStatusStore()
    store.report('old', needsApproval('Old', 'ho'))
    const listener = vi.fn()
    store.subscribe(listener)

    store.beginBatch()
    store.report('matrix', needsApproval('Matrix', 'hm'))
    store.report('readwise', needsApproval('Readwise', 'hr'))

    // Mid-resolve the UI still sees the PREVIOUS complete set — no empty
    // intermediate frame (that blank was the toast/chip flicker).
    expect(listener).not.toHaveBeenCalled()
    expect([...store.getSnapshot().keys()]).toEqual(['old'])

    store.commitBatch()

    // One notify; the rebuilt set (the un-reported 'old' block dropped out).
    expect(listener).toHaveBeenCalledTimes(1)
    expect([...store.getSnapshot().keys()].sort()).toEqual(['matrix', 'readwise'])
  })

  it('commitBatch with nothing re-reported clears the map in one notify', () => {
    const store = new ExtensionApprovalStatusStore()
    store.report('old', needsApproval('Old', 'ho'))
    const listener = vi.fn()
    store.subscribe(listener)

    store.beginBatch()
    store.commitBatch()

    expect(store.getSnapshot().size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reset() abandons an open batch and clears', () => {
    const store = new ExtensionApprovalStatusStore()
    store.report('old', needsApproval('Old', 'ho'))

    store.beginBatch()
    store.report('matrix', needsApproval('Matrix', 'hm'))
    store.reset()

    // reset drops both the live set and the buffer; a later commit is a no-op.
    expect(store.getSnapshot().size).toBe(0)
    const listener = vi.fn()
    store.subscribe(listener)
    store.commitBatch()
    expect(listener).not.toHaveBeenCalled()
  })
})
