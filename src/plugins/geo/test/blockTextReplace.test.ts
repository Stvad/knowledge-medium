import { describe, expect, it } from 'vitest'
import { locateText } from '../blockTextReplace'

describe('locateText', () => {
  it('uses the recorded span when the trigger text is still there', () => {
    expect(locateText('met at @blue', '@blue', {from: 7, to: 12}))
      .toEqual({from: 7, to: 12})
  })

  it('re-locates the trigger text when the doc drifted around it', () => {
    // Text was prepended while the resolution was pending — the
    // recorded span no longer lines up.
    expect(locateText('yesterday we met at @blue', '@blue', {from: 7, to: 12}))
      .toEqual({from: 20, to: 25})
  })

  it('returns null when the trigger text is gone', () => {
    expect(locateText('met at home', '@blue', {from: 7, to: 12})).toBeNull()
  })

  it('returns null for an empty trigger', () => {
    expect(locateText('met at @blue', '', {from: 7, to: 7})).toBeNull()
  })
})
