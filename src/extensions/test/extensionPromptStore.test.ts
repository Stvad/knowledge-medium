import {describe, expect, it} from 'vitest'
import type {ExtensionApprovalStatus} from '@/extensions/dynamicExtensions.js'
import {
  pendingExtensionPrompts,
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

describe('pendingExtensionPrompts', () => {
  it('emits every pending extension, all un-dismissed when nothing is dismissed', () => {
    const statuses = new Map<string, ExtensionApprovalStatus>([
      ['matrix', needsApproval('Matrix', 'hm')],
      ['readwise', updateAvailable('Readwise', 'hr')],
    ])

    const pending = pendingExtensionPrompts(statuses, {})

    expect(pending.map((p) => p.blockId).sort()).toEqual(['matrix', 'readwise'])
    expect(pending.every((p) => !p.dismissed)).toBe(true)
    expect(pending.find((p) => p.blockId === 'matrix')).toMatchObject({
      name: 'Matrix',
      kind: 'needs-approval',
      liveHash: 'hm',
    })
  })

  it('tags ONLY the dismissed extension — the repro fix', () => {
    // Matrix + Readwise both pending. Dismissing Matrix must tag only Matrix
    // (the reported bug hid a different extension's prompt). Both stay in the
    // list (the chip keeps a quiet row); the toast surface filters !dismissed.
    const statuses = new Map<string, ExtensionApprovalStatus>([
      ['matrix', needsApproval('Matrix', 'hm')],
      ['readwise', needsApproval('Readwise', 'hr')],
    ])

    const pending = pendingExtensionPrompts(statuses, {matrix: 'hm'})

    expect(pending.find((p) => p.blockId === 'matrix')?.dismissed).toBe(true)
    expect(pending.find((p) => p.blockId === 'readwise')?.dismissed).toBe(false)
    // The loud toast set (non-dismissed) is Readwise only.
    expect(pending.filter((p) => !p.dismissed).map((p) => p.blockId)).toEqual([
      'readwise',
    ])
  })

  it('a dismissal only applies to the exact source version it was made for', () => {
    // Dismissed at hash 'h1', but the live source is now 'h2' → not dismissed,
    // so a fresh update still nudges.
    const statuses = new Map<string, ExtensionApprovalStatus>([
      ['ext', updateAvailable('Ext', 'h2')],
    ])

    expect(pendingExtensionPrompts(statuses, {ext: 'h1'})[0].dismissed).toBe(false)
    expect(pendingExtensionPrompts(statuses, {ext: 'h2'})[0].dismissed).toBe(true)
  })
})

describe('extensionPromptStore', () => {
  it('keeps a stable snapshot ref when re-published with equal content', () => {
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'needs-approval', liveHash: 'h', dismissed: false},
    ])
    const first = extensionPromptStore.getSnapshot()

    // Same content, fresh array — must be deduped so useSyncExternalStore
    // consumers (the status chip) don't churn.
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'needs-approval', liveHash: 'h', dismissed: false},
    ])
    expect(extensionPromptStore.getSnapshot()).toBe(first)

    // A dismissal flip is a real change — swaps the ref and notifies (so the
    // diagnostic can drop its nudge dot).
    let notified = 0
    const unsub = extensionPromptStore.subscribe(() => notified++)
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'needs-approval', liveHash: 'h', dismissed: true},
    ])
    expect(extensionPromptStore.getSnapshot()).not.toBe(first)
    expect(notified).toBe(1)
    unsub()
    extensionPromptStore.set([])
  })
})
