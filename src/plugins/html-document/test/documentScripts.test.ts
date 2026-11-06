// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from 'vitest'
import {decideScripts, hasScripts} from '../documentScripts.ts'
import {grantConsent, readConsent, revokeConsent, subscribeToConsent} from '../scriptConsent.ts'

describe('decideScripts', () => {
  it('holds a document the viewer has not allowed', () => {
    expect(decideScripts(null, 'hash-a')).toBe('hold')
  })

  it('runs the version the viewer allowed on this device', () => {
    expect(decideScripts('hash-a', 'hash-a')).toBe('run')
  })

  it('holds again once the source changes', () => {
    expect(decideScripts('hash-a', 'hash-b')).toBe('hold')
  })

  it('holds when the source could not be hashed, even against a matching absence', () => {
    expect(decideScripts(null, null)).toBe('hold')
  })
})

describe('hasScripts', () => {
  it.each([
    '<script>x()</script>',
    '<SCRIPT src="x"></SCRIPT>',
    '<img src=x onerror=x()>',
    '<svg ONLOAD = "x()">',
    '<a href="javascript:x()">x</a>',
  ])('offers to run %s', source => {
    expect(hasScripts(source)).toBe(true)
  })

  it.each([
    '',
    '<p>Plain text about scripts and online things</p>',
    '<style>a{color:red}</style><div style="height:9px"></div>',
  ])('has nothing to offer for %j', source => {
    expect(hasScripts(source)).toBe(false)
  })
})

describe('script consent', () => {
  beforeEach(() => localStorage.clear())

  it('is per block', () => {
    grantConsent('a', 'hash')
    expect(readConsent('a')).toBe('hash')
    expect(readConsent('b')).toBeNull()
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
