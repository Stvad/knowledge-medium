import { describe, expect, it } from 'vitest'
import { charCountDisplay } from '../charCount'

describe('charCountDisplay', () => {
  it('shows a bare count when no limit is set', () => {
    expect(charCountDisplay(0)).toEqual({text: '0', over: false})
    expect(charCountDisplay(42)).toEqual({text: '42', over: false})
  })

  it('shows count / limit and is not over while under the limit', () => {
    expect(charCountDisplay(10, 280)).toEqual({text: '10 / 280', over: false})
  })

  it('treats being exactly at the limit as not over', () => {
    expect(charCountDisplay(280, 280)).toEqual({text: '280 / 280', over: false})
  })

  it('flags over once the count strictly exceeds the limit', () => {
    expect(charCountDisplay(281, 280)).toEqual({text: '281 / 280', over: true})
  })

  it('ignores a non-positive or non-finite limit (treats it as no limit)', () => {
    expect(charCountDisplay(5, 0)).toEqual({text: '5', over: false})
    expect(charCountDisplay(5, -10)).toEqual({text: '5', over: false})
    expect(charCountDisplay(5, Number.NaN)).toEqual({text: '5', over: false})
  })
})
