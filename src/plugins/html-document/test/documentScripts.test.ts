// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from 'vitest'
import {decideScripts, hasScripts} from '../documentScripts.ts'
import {grantConsent, readConsent, revokeConsent, subscribeToConsent} from '../scriptConsent.ts'

const ME = 'me'

describe('decideScripts', () => {
  const decide = (over: Partial<Parameters<typeof decideScripts>[0]>) =>
    decideScripts({memberIds: [ME], me: ME, consentedHash: null, sourceHash: 'hash-a', ...over})

  it('runs a document when the viewer is the workspace\'s only member', () => {
    expect(decide({})).toBe('run')
  })

  it('holds a document anyone else could have written', () => {
    expect(decide({memberIds: [ME, 'other']})).toBe('hold')
  })

  it('holds when the viewer\'s own membership has not arrived, whoever else is there', () => {
    expect(decide({memberIds: []})).toBe('hold')
    expect(decide({memberIds: ['other']})).toBe('hold')
  })

  it('runs the version of a shared document the viewer allowed on this device', () => {
    expect(decide({memberIds: [ME, 'other'], consentedHash: 'hash-a'})).toBe('run')
  })

  it('holds again once the source changes', () => {
    expect(decide({memberIds: [ME, 'other'], consentedHash: 'hash-a', sourceHash: 'hash-b'})).toBe('hold')
  })

  it('holds when the source could not be hashed, even against a matching absence', () => {
    expect(decide({memberIds: [ME, 'other'], consentedHash: null, sourceHash: null})).toBe('hold')
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
