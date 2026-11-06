// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from 'vitest'
import {decideScripts, hasScripts, isOnlyEverViewer} from '../documentScripts.ts'
import {grantConsent, readConsent, revokeConsent, subscribeToConsent} from '../scriptConsent.ts'

describe('isOnlyEverViewer', () => {
  it('trusts the server saying nobody else has ever been a member', () => {
    expect(isOnlyEverViewer(0, true)).toBe(true)
  })

  it('holds once anyone else has been a member, whether or not they are still', () => {
    expect(isOnlyEverViewer(1, true)).toBe(false)
    expect(isOnlyEverViewer(1, false)).toBe(false)
  })

  it.each([[null], [undefined]])('reads %s from a synced workspace as may have had', value => {
    expect(isOnlyEverViewer(value, true)).toBe(false)
  })

  it.each([[null], [undefined]])('reads %s in a local-only workspace as nobody else', value => {
    expect(isOnlyEverViewer(value, false)).toBe(true)
  })
})

describe('decideScripts', () => {
  const decide = (over: Partial<Parameters<typeof decideScripts>[0]>) =>
    decideScripts({onlyEverViewer: false, consentedHash: null, sourceHash: 'hash-a', ...over})

  it('runs a document only the viewer could have written', () => {
    expect(decide({onlyEverViewer: true})).toBe('run')
  })

  it('holds a document anyone else could have written', () => {
    expect(decide({})).toBe('hold')
  })

  it('runs the version the viewer allowed on this device', () => {
    expect(decide({consentedHash: 'hash-a'})).toBe('run')
  })

  it('holds again once the source changes', () => {
    expect(decide({consentedHash: 'hash-a', sourceHash: 'hash-b'})).toBe('hold')
  })

  it('holds when the source could not be hashed, even against a matching absence', () => {
    expect(decide({consentedHash: null, sourceHash: null})).toBe('hold')
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
