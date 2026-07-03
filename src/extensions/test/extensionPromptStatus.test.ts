// @vitest-environment jsdom
import {afterEach, describe, expect, it} from 'vitest'
import {extensionPromptStore} from '@/extensions/extensionPromptStore.js'
import {extensionPromptDiagnosticSource} from '@/extensions/extensionPromptStatus.js'
import {OPEN_EXTENSIONS_SETTINGS_ACTION_ID} from '@/plugins/extensions-settings/actions.js'

afterEach(() => extensionPromptStore.set([]))

describe('extension-prompts diagnostic source', () => {
  it('reports nothing when no extensions are pending', () => {
    extensionPromptStore.set([])
    expect(extensionPromptDiagnosticSource.getSnapshot()).toBeNull()
  })

  it('summarizes the pending count and routes to Extensions settings', () => {
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'needs-approval', liveHash: 'h'},
      {blockId: 'b', name: 'B', kind: 'update-available', liveHash: 'h'},
    ])

    const snap = extensionPromptDiagnosticSource.getSnapshot()
    expect(snap).toMatchObject({
      severity: 'info',
      summary: '2 extensions need review',
      actionId: OPEN_EXTENSIONS_SETTINGS_ACTION_ID,
      actionLabel: 'Review',
      nudge: true,
    })
  })

  it('uses the singular form for a single pending extension', () => {
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'needs-approval', liveHash: 'h'},
    ])
    expect(extensionPromptDiagnosticSource.getSnapshot()?.summary).toBe(
      'An extension needs review',
    )
  })

  it('returns a referentially-stable snapshot while the set is unchanged', () => {
    extensionPromptStore.set([
      {blockId: 'a', name: 'A', kind: 'needs-approval', liveHash: 'h'},
    ])
    const first = extensionPromptDiagnosticSource.getSnapshot()
    expect(extensionPromptDiagnosticSource.getSnapshot()).toBe(first)
  })
})
