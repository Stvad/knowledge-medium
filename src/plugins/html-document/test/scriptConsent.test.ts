// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from 'vitest'
import {grantConsent, readConsent, revokeConsent, subscribeToConsent} from '../scriptConsent.ts'

describe('script consent', () => {
  beforeEach(() => localStorage.clear())

  it('is per block', () => {
    grantConsent('a', 'hash')
    expect(readConsent('a')).toBe('hash')
    expect(readConsent('b')).toBe('')
  })

  it('tells subscribers, and revoking clears it', () => {
    let calls = 0
    const unsubscribe = subscribeToConsent(() => {
      calls += 1
    })
    grantConsent('a', 'hash')
    revokeConsent('a')
    unsubscribe()
    grantConsent('a', 'hash')
    expect(calls).toBe(2)
    expect(readConsent('a')).toBe('hash')
  })
})
