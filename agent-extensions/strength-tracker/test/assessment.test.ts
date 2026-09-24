import {describe, expect, it} from 'vitest'

import {sideGap} from '../src/engine/assessment'

describe('sideGap', () => {
  it('flags a gap over 15% and names the weaker side', () => {
    expect(sideGap(8, 10)).toEqual({gap: 0.2, extraSetOn: 'L'})
    expect(sideGap(34, 40)?.extraSetOn).toBeUndefined()
    expect(sideGap(10, 5)?.extraSetOn).toBe('R')
  })

  it('measures the gap against the better side, so it reads the same either way round', () => {
    expect(sideGap(10, 8)?.gap).toBe(sideGap(8, 10)?.gap)
  })

  it('leaves exactly 15% unflagged — the rule is "over"', () => {
    expect(sideGap(17, 20)?.extraSetOn).toBeUndefined()
  })

  it('is a zero gap when the sides are level', () => {
    expect(sideGap(12, 12)).toEqual({gap: 0})
  })

  it('says nothing until both sides are in, or when both are zero', () => {
    expect(sideGap(10, undefined)).toBeUndefined()
    expect(sideGap(0, 0)).toBeUndefined()
  })
})
