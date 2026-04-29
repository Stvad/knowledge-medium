import { describe, expect, it } from 'vitest'
import { applyHeading, rewriteRoamContent } from '../content'

const uidMap = new Map<string, string>([
  ['vgkFNA64b', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
  ['3iAWxE3r8', '11111111-2222-4333-8444-555555555555'],
])

describe('rewriteRoamContent', () => {
  it('rewrites bare block refs to mapped uuids', () => {
    const {content, unresolvedBlockUids} = rewriteRoamContent(
      '**Weekly focus:** ((vgkFNA64b))',
      uidMap,
    )
    expect(content).toBe('**Weekly focus:** ((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee))')
    expect(unresolvedBlockUids).toEqual([])
  })

  it('rewrites embed macro to !((uuid))', () => {
    const {content} = rewriteRoamContent(
      '{{embed: ((vgkFNA64b))}} and {{ embed : ((3iAWxE3r8)) }}',
      uidMap,
    )
    expect(content).toBe(
      '!((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)) and !((11111111-2222-4333-8444-555555555555))',
    )
  })

  it('preserves label on aliased block ref [text](((uid)))', () => {
    const {content} = rewriteRoamContent(
      '[control hip weight transfer](((vgkFNA64b)))',
      uidMap,
    )
    expect(content).toBe(
      '[control hip weight transfer] ((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee))',
    )
  })

  it('records and preserves unresolved block uids', () => {
    const {content, unresolvedBlockUids} = rewriteRoamContent(
      '((nope_unknown)) and ((vgkFNA64b))',
      uidMap,
    )
    expect(content).toBe(
      '((nope_unknown)) and ((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee))',
    )
    expect(unresolvedBlockUids).toEqual(['nope_unknown'])
  })

  it('converts #tag to [[tag]]', () => {
    const {content} = rewriteRoamContent('drill #srm and #wcs/footwork', new Map())
    expect(content).toBe('drill [[srm]] and [[wcs/footwork]]')
  })

  it('converts #[[multi word]] to [[multi word]]', () => {
    const {content} = rewriteRoamContent('see #[[Get really good at dancing]]', new Map())
    expect(content).toBe('see [[Get really good at dancing]]')
  })

  it('does not match # inside URLs', () => {
    const {content} = rewriteRoamContent(
      'visit https://example.com/foo#bar and #realtag',
      new Map(),
    )
    expect(content).toBe('visit https://example.com/foo#bar and [[realtag]]')
  })

  it('does not match # mid-identifier', () => {
    const {content} = rewriteRoamContent('a#b is not a tag, but #b is', new Map())
    expect(content).toBe('a#b is not a tag, but [[b]] is')
  })

  it('leaves [[Page]] page refs alone', () => {
    const {content} = rewriteRoamContent('see [[April 28th, 2026]]', uidMap)
    expect(content).toBe('see [[April 28th, 2026]]')
  })
})

describe('applyHeading', () => {
  it('prepends # for heading 1', () => {
    expect(applyHeading('Title', 1)).toBe('# Title')
  })

  it('prepends ### for heading 3', () => {
    expect(applyHeading('Sub', 3)).toBe('### Sub')
  })

  it('caps at heading 6', () => {
    expect(applyHeading('Deep', 9)).toBe('###### Deep')
  })

  it('returns content unchanged when heading absent or 0', () => {
    expect(applyHeading('plain', undefined)).toBe('plain')
    expect(applyHeading('plain', 0)).toBe('plain')
  })
})
