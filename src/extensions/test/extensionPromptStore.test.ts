import {describe, expect, it} from 'vitest'
import type {ExtensionApprovalStatus} from '@/extensions/dynamicExtensions.js'
import {
  activeExtensionPrompts,
  extensionPromptStore,
} from '@/extensions/extensionPromptStore.js'

const needsApproval = (name: string, liveHash: string): ExtensionApprovalStatus => ({
  kind: 'needs-approval',
  name,
  liveHash,
})

const updateAvailable = (
  name: string,
  liveHash: string,
): ExtensionApprovalStatus => ({
  kind: 'update-available',
  name,
  liveHash,
  approvedHash: 'approved',
})

describe('activeExtensionPrompts', () => {
  it('surfaces every enabled-but-not-running extension when nothing is dismissed', () => {
    const statuses = new Map<string, ExtensionApprovalStatus>([
      ['matrix', needsApproval('Matrix', 'hm')],
      ['readwise', updateAvailable('Readwise', 'hr')],
    ])

    const active = activeExtensionPrompts(statuses, {})

    expect(active.map((p) => p.blockId).sort()).toEqual(['matrix', 'readwise'])
    expect(active.find((p) => p.blockId === 'matrix')).toMatchObject({
      name: 'Matrix',
      kind: 'needs-approval',
      liveHash: 'hm',
    })
  })

  it('dismissing one extension hides ONLY that one — the repro fix', () => {
    // Matrix + Readwise both pending. Dismissing Matrix must not touch
    // Readwise (the reported bug hid a different extension's prompt).
    const statuses = new Map<string, ExtensionApprovalStatus>([
      ['matrix', needsApproval('Matrix', 'hm')],
      ['readwise', needsApproval('Readwise', 'hr')],
    ])

    const active = activeExtensionPrompts(statuses, {matrix: 'hm'})

    expect(active.map((p) => p.blockId)).toEqual(['readwise'])
  })

  it('a dismissal only applies to the exact source version it was made for', () => {
    // Dismissed at hash 'h1', but the live source is now 'h2' → the prompt
    // re-surfaces so a fresh update still nudges.
    const statuses = new Map<string, ExtensionApprovalStatus>([
      ['ext', updateAvailable('Ext', 'h2')],
    ])

    expect(activeExtensionPrompts(statuses, {ext: 'h1'})).toHaveLength(1)
    expect(activeExtensionPrompts(statuses, {ext: 'h2'})).toHaveLength(0)
  })
})

describe('extensionPromptStore', () => {
  it('keeps a stable snapshot ref when re-published with equal content', () => {
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'needs-approval', liveHash: 'h'},
    ])
    const first = extensionPromptStore.getSnapshot()

    // Same content, fresh array — must be deduped so useSyncExternalStore
    // consumers (the status chip) don't churn.
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'needs-approval', liveHash: 'h'},
    ])
    expect(extensionPromptStore.getSnapshot()).toBe(first)

    // A real change swaps the ref and notifies.
    let notified = 0
    const unsub = extensionPromptStore.subscribe(() => notified++)
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'update-available', liveHash: 'h'},
    ])
    expect(extensionPromptStore.getSnapshot()).not.toBe(first)
    expect(notified).toBe(1)
    unsub()
    extensionPromptStore.set([])
  })
})
