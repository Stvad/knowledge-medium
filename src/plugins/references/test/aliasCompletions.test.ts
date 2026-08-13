import { describe, expect, it } from 'vitest'
import type { TypeContribution } from '@/data/api'
import { aliasCompletions } from '../codeMirrorExtensions.ts'
import { MAX_ALIAS_LENGTH } from '../referenceParser.ts'

const registry = new Map<string, TypeContribution>()

const row = (label: string) => ({label, typeIds: [] as readonly string[]})

describe('aliasCompletions', () => {
  it('offers ordinary alias targets', () => {
    expect(aliasCompletions([row('Inbox'), row('Reading list')], registry)
      .map(c => c.label)).toEqual(['Inbox', 'Reading list'])
  })

  // A workspace can already hold aliases the `[[…]]` grammar can't carry —
  // the phantom pages this PR is about are exactly that, and several begin
  // `import {`, so `[[import ` would surface them. Accepting one writes a
  // span the parser reads no reference from: literal text, no backlink,
  // no explanation on screen.
  it('drops a target longer than the grammar can carry', () => {
    const oversized = 'a'.repeat(MAX_ALIAS_LENGTH + 1)
    expect(aliasCompletions([row('Inbox'), row(oversized)], registry)
      .map(c => c.label)).toEqual(['Inbox'])
  })

  // Not a blanket "long names are bad" rule — the boundary is whether a
  // reference comes back, so an at-cap name is still offered.
  it('keeps a target at exactly the cap', () => {
    const atCap = 'a'.repeat(MAX_ALIAS_LENGTH)
    expect(aliasCompletions([row(atCap)], registry).map(c => c.label)).toEqual([atCap])
  })

  // Deliberately weaker than a faithfulness check: lossy-but-working
  // targets that the editor accepts today keep being offered, so adding
  // the filter cannot newly hide an alias a user could previously link.
  it('still offers lossy-but-linkable targets', () => {
    expect(aliasCompletions([row('C:\\path'), row('array]')], registry)
      .map(c => c.label)).toEqual(['C:\\path', 'array]'])
  })
})
