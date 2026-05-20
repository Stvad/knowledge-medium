import { describe, expect, it } from 'vitest'
import {
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
})
