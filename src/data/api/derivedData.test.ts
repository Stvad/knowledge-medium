import { describe, it, expect } from 'vitest'
import { reconcileDerived, derivedRefKey } from './derivedData'
import type { BlockReference } from './blockData'

// reconcileDerived is the runtime chokepoint for the "derived data is add-only
// / retain-on-source" contract (docs/contracts/derived-data-add-only.md). These
// pin the two facets every derive site relies on: (1) a partial recompute can't
// drop a prior element it couldn't reproduce when `retain` keeps it; (2) a
// genuine value-driven removal still goes through (retain returns false).

const ref = (id: string, sourceField?: string): BlockReference =>
  sourceField === undefined ? { id, alias: id } : { id, alias: id, sourceField }

describe('reconcileDerived', () => {
  it('defaults to pure add-only: retains every prior element (reprojection shape)', () => {
    // Recompute only re-derived `a`; `b` (a prior derived ref) must survive even
    // though this recompute didn't reproduce it.
    const result = reconcileDerived({
      prior: [ref('a', 'field'), ref('b', 'field')],
      recomputed: [ref('a', 'field')],
      keyOf: derivedRefKey,
    })
    expect(result.map(r => r.id).sort()).toEqual(['a', 'b'])
  })

  it('adds newly-recomputed elements while keeping prior (no duplicates)', () => {
    const result = reconcileDerived({
      prior: [ref('a', 'field')],
      recomputed: [ref('a', 'field'), ref('c', 'field')],
      keyOf: derivedRefKey,
    })
    expect(result.map(r => r.id).sort()).toEqual(['a', 'c'])
  })

  it('drops a prior element when retain returns false (value-driven removal is allowed)', () => {
    // The legitimate case: the source changed and the recompute is authoritative,
    // so a prior element the recompute didn't reproduce and that retain rejects
    // is correctly removed — the contract forbids dropping, not all removal.
    const result = reconcileDerived({
      prior: [ref('a', 'field'), ref('stale', 'field')],
      recomputed: [ref('a', 'field')],
      keyOf: derivedRefKey,
      retain: () => false,
    })
    expect(result.map(r => r.id)).toEqual(['a'])
  })

  it('retains only the prior elements retain selects', () => {
    const result = reconcileDerived({
      prior: [ref('keep', 'absent'), ref('drop', 'present')],
      recomputed: [],
      keyOf: derivedRefKey,
      retain: r => r.sourceField === 'absent',
    })
    expect(result.map(r => r.id)).toEqual(['keep'])
  })

  it('keys on (sourceField, id) so the same id under different fields is distinct', () => {
    const result = reconcileDerived({
      prior: [ref('x', 'fieldB')],
      recomputed: [ref('x', 'fieldA')],
      keyOf: derivedRefKey,
    })
    // Both survive — same id, different sourceField ⇒ different derived element.
    expect(result.map(derivedRefKey).sort()).toEqual(
      [ref('x', 'fieldA'), ref('x', 'fieldB')].map(derivedRefKey).sort(),
    )
  })
})
