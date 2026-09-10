// @vitest-environment node
/**
 * Unit tests for `mergeReferrers` — the union half of the references-parse
 * fence (§11 group 4).
 *
 * These exist because nothing pinned its semantics, and its docblock had
 * claimed an ordering guarantee it doesn't provide. The fence's END-TO-END
 * behaviour is covered in
 * `renameProcessor.test.ts`; what's pinned here is the contract a future
 * maintainer would otherwise have to re-derive: union not intersection,
 * first-occurrence wins, order preserved within a group but NOT across
 * groups.
 */

import { describe, expect, it } from 'vitest'
import { mergeReferrers } from '../parseFence.ts'

const row = (sourceId: string, content = `see [[X]] in ${sourceId}`) =>
  ({sourceId, content})

describe('mergeReferrers', () => {
  it('is a union — a row only one leg found survives', () => {
    // The whole point of two legs: the edge leg sees an edge that outlived
    // its span, the content leg sees a span whose edge is unparsed. Losing
    // either would reopen a hole.
    expect(mergeReferrers([row('edge-only')], [row('content-only')])
      .map(r => r.sourceId))
      .toEqual(['edge-only', 'content-only'])
  })

  it('dedupes by id, keeping the FIRST occurrence', () => {
    // Both legs return the same row in the common case (a drained referrer),
    // and the enumeration must plan it once — a second plan for one source
    // would splice its spans twice.
    const merged = mergeReferrers(
      [row('both', 'from the edge leg')],
      [row('both', 'from the content leg')],
    )
    expect(merged).toEqual([{sourceId: 'both', content: 'from the edge leg'}])
  })

  it('concatenates group-by-group — it does NOT globally sort', () => {
    // The corrected contract. Each leg arrives in its own (order_key, id)
    // order; the result keeps that order WITHIN a group and appends groups
    // in argument order. So a content-leg row that sorts first overall still
    // lands last. Asserted so the docblock and the code can't drift apart
    // again, and so anyone who needs a global sort has to add it knowingly.
    expect(mergeReferrers([row('z')], [row('a'), row('b')]).map(r => r.sourceId))
      .toEqual(['z', 'a', 'b'])
  })

  it('is deterministic and total over any number of groups', () => {
    const args = [[row('a'), row('b')], [row('b'), row('c')], [], [row('a')]]
    expect(mergeReferrers(...args).map(r => r.sourceId)).toEqual(['a', 'b', 'c'])
    expect(mergeReferrers(...args)).toEqual(mergeReferrers(...args))
    expect(mergeReferrers()).toEqual([])
  })
})
