// @vitest-environment node
//
// The promotion core's decline by VALUE. (The by-NAME decline is pinned in
// plan.test.ts.)
//
// What is load-bearing is not the absence of the key but what happens to its
// bullets: a SUBTRACTIVE consumer drops whatever promotion reports as
// consumed, so a withdrawal that left those uids marked consumed would destroy
// the text, and one that forgot to report them as `declined` would let a
// deeper pass re-judge and hoist them anyway.
import { describe, expect, it } from 'vitest'
import { computePromotedFromChildren } from '../promotion'
import type { RoamBlock } from '../types'

const child = (uid: string, string: string, children?: RoamBlock[]): RoamBlock =>
  ({uid, string, ...(children ? {children} : {})}) as RoamBlock

const promote = (
  children: RoamBlock[],
  acceptValue?: (propName: string, value: unknown) => boolean,
) => computePromotedFromChildren(children, new Set<string>(), {
  namespacePrefix: 'test',
  ...(acceptValue ? {acceptValue} : {}),
})

describe('computePromotedFromChildren: declining by value', () => {
  it('withdraws only the declined key when one parent carries both kinds', () => {
    // The mixed case is the one a single-key test cannot see: a decline that
    // is chosen per CALL rather than per KEY passes with one key and destroys
    // the other's property, or keeps a bullet whose value was promoted anyway.
    const result = promote(
      [child('u1', 'count:: many'), child('u2', 'note:: from the room')],
      propName => propName !== 'test:count',
    )

    expect(result.promoted).toEqual({'test:note': 'from the room'})
    expect([...result.bubbled]).toEqual(['u2'])
    // Reported, not merely un-bubbled: a caller walking deeper has to keep
    // treating it as decided, or it gets promoted one level down instead.
    expect([...result.declined]).toEqual(['u1'])
    expect(result.diagnostics.join(' ')).toContain('test:count')
  })

  it('judges the FINALIZED value, not each occurrence, since that is what the cell holds', () => {
    // Two same-key siblings fold into one array before anything can judge
    // them, which is why this cannot be answered by `acceptKey`.
    const seen: unknown[] = []
    const result = promote(
      [child('u1', 'tag:: one'), child('u2', 'tag:: two')],
      (_propName, value) => { seen.push(value); return false },
    )

    expect(seen).toEqual([['one', 'two']])
    // All-or-nothing per key: the cell holds one value, so a batch with an
    // unusable member has no partial form to keep — both bullets come back.
    expect(result.promoted).toEqual({})
    expect([...result.bubbled]).toEqual([])
  })

  it('un-bubbles only the declined key\'s own source, not a nested attribute\'s', () => {
    // `count` bubbles up THROUGH `meta` from one level down. Each bubbled uid
    // feeds exactly one key, so withdrawing `count` must return u2 and leave
    // `meta`'s own consumption alone.
    const result = promote(
      [child('u1', 'meta:: outer', [child('u2', 'count:: many')])],
      propName => propName !== 'test:count',
    )

    expect(result.promoted).toEqual({'test:meta': 'outer'})
    expect([...result.bubbled]).toEqual(['u1'])
  })
})
