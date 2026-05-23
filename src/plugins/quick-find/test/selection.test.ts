import { describe, expect, it } from 'vitest'
import {
  quickFindOpenTargetFromClickModifiers,
  quickFindOpenTargetFromModifiers,
  quickFindSelectionAction,
  nextQuickFindSelection,
  quickFindAliasValue,
  quickFindCreateValue,
  quickFindDateValue,
} from '../selection.ts'

describe('quick find selection', () => {
  it('moves from the transient create item to the first async result', () => {
    const firstAlias = {alias: 'Alpha', blockId: 'alpha-id', content: 'Alpha page'}

    expect(nextQuickFindSelection({
      query: 'alp',
      aliases: [firstAlias],
      blocks: [],
      dateValues: [],
      currentValue: quickFindCreateValue('alp'),
    })).toBe(quickFindAliasValue(firstAlias))
  })

  it('selects create when a completed search has no results', () => {
    expect(nextQuickFindSelection({
      query: 'zzzz',
      aliases: [],
      blocks: [],
      dateValues: [],
      currentValue: 'page:stale-id:stale',
    })).toBe(quickFindCreateValue('zzzz'))
  })

  it('keeps date selected as the first visible item when a query parses as a date', () => {
    const firstAlias = {alias: 'Tomorrow project', blockId: 'project-id', content: 'Tomorrow project'}

    expect(nextQuickFindSelection({
      query: 'tomorrow',
      aliases: [firstAlias],
      blocks: [],
      dateValues: [quickFindDateValue('2026-05-12')],
      currentValue: quickFindCreateValue('tomorrow'),
    })).toBe(quickFindDateValue('2026-05-12'))
  })

  it('selects the first date candidate when multiple date candidates are visible', () => {
    expect(nextQuickFindSelection({
      query: 'to',
      aliases: [],
      blocks: [],
      dateValues: [
        quickFindDateValue('2026-05-11'),
        quickFindDateValue('2026-05-12'),
      ],
      currentValue: '',
    })).toBe(quickFindDateValue('2026-05-11'))
  })

  it('keeps the current selection when it is one of several date candidates', () => {
    expect(nextQuickFindSelection({
      query: 'to',
      aliases: [],
      blocks: [],
      dateValues: [
        quickFindDateValue('2026-05-11'),
        quickFindDateValue('2026-05-12'),
      ],
      currentValue: quickFindDateValue('2026-05-12'),
    })).toBe(quickFindDateValue('2026-05-12'))
  })

  it('uses stack target for quick-find modifier selections', () => {
    expect(quickFindOpenTargetFromModifiers({shiftKey: true})).toBe('stack')
    expect(quickFindOpenTargetFromModifiers({metaKey: true})).toBe('stack')
    expect(quickFindOpenTargetFromModifiers({ctrlKey: true})).toBe('stack')
    expect(quickFindOpenTargetFromModifiers({})).toBe('jump')
  })

  it('uses stack target only for shift-click selections', () => {
    expect(quickFindOpenTargetFromClickModifiers({shiftKey: true})).toBe('stack')
    expect(quickFindOpenTargetFromClickModifiers({})).toBe('jump')
  })

  it('preserves stack target for date and create selections', () => {
    expect(quickFindSelectionAction(quickFindDateValue('2026-05-23'), 'stack')).toEqual({
      kind: 'open-date',
      iso: '2026-05-23',
      target: 'stack',
    })
    expect(quickFindSelectionAction(quickFindCreateValue('New Page'), 'stack')).toEqual({
      kind: 'create-page',
      alias: 'New Page',
      target: 'stack',
    })
  })

  it('extracts block ids from page, block, and recent selections', () => {
    expect(quickFindSelectionAction('page:block-id:Alias', 'jump')).toEqual({
      kind: 'open-block',
      blockId: 'block-id',
      target: 'jump',
    })
    expect(quickFindSelectionAction('block:block-id', 'stack')).toEqual({
      kind: 'open-block',
      blockId: 'block-id',
      target: 'stack',
    })
    expect(quickFindSelectionAction('recent:recent-id', 'jump')).toEqual({
      kind: 'open-block',
      blockId: 'recent-id',
      target: 'jump',
    })
  })
})
