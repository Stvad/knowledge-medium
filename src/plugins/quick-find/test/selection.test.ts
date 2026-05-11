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
      dateValue: '',
      currentValue: quickFindCreateValue('alp'),
    })).toBe(quickFindAliasValue(firstAlias))
  })

  it('selects create when a completed search has no results', () => {
    expect(nextQuickFindSelection({
      query: 'zzzz',
      aliases: [],
      blocks: [],
      dateValue: '',
      currentValue: 'page:stale-id:stale',
    })).toBe(quickFindCreateValue('zzzz'))
  })

  it('keeps date selected as the first visible item when a query parses as a date', () => {
    const firstAlias = {alias: 'Tomorrow project', blockId: 'project-id', content: 'Tomorrow project'}

    expect(nextQuickFindSelection({
      query: 'tomorrow',
      aliases: [firstAlias],
      blocks: [],
      dateValue: quickFindDateValue('2026-05-12'),
      currentValue: quickFindCreateValue('tomorrow'),
    })).toBe(quickFindDateValue('2026-05-12'))
  })
})
