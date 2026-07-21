// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest'
import {extensionPromptStore} from '@/extensions/extensionPromptStore.js'
import {extensionPromptDiagnosticSource} from '@/extensions/extensionPromptStatus.js'
import {OPEN_EXTENSIONS_SETTINGS_ACTION_ID} from '@/plugins/extensions-settings/actions.js'

const prompt = (blockId: string, dismissed = false) => ({
  blockId,
  name: blockId.toUpperCase(),
  kind: 'needs-approval' as const,
  liveHash: 'h',
  dismissed,
})

afterEach(() => extensionPromptStore.set([]))

describe('extension-prompts diagnostic source', () => {
  it('reports nothing when no extensions are pending', () => {
    extensionPromptStore.set([])
    expect(extensionPromptDiagnosticSource.getSnapshot()).toBeNull()
  })

  it('summarizes the pending count, nudges, and routes to Extensions settings', () => {
    extensionPromptStore.set([prompt('a'), prompt('b')])

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
    extensionPromptStore.set([prompt('a')])
    expect(extensionPromptDiagnosticSource.getSnapshot()?.summary).toBe(
      'An extension needs review',
    )
  })

  it('keeps the row but drops the nudge once every prompt is dismissed (design C)', () => {
    // Mixed: still nudges while one is non-dismissed.
    extensionPromptStore.set([prompt('a', true), prompt('b', false)])
    expect(extensionPromptDiagnosticSource.getSnapshot()).toMatchObject({
      summary: '2 extensions need review',
      nudge: true,
    })

    // All dismissed: the row stays (still discoverable) but the dot is gone.
    extensionPromptStore.set([prompt('a', true), prompt('b', true)])
    expect(extensionPromptDiagnosticSource.getSnapshot()).toMatchObject({
      summary: '2 extensions need review',
      nudge: false,
    })
  })

  it('returns a referentially-stable snapshot while the set is unchanged', () => {
    extensionPromptStore.set([prompt('a')])
    const first = extensionPromptDiagnosticSource.getSnapshot()
    expect(extensionPromptDiagnosticSource.getSnapshot()).toBe(first)
  })
})
