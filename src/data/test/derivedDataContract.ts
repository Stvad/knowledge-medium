import { expect } from 'vitest'

/**
 * Shared assertion for the **element-wise decode** facet of the "derived data
 * is add-only / retain-on-source" contract
 * (docs/contracts/derived-data-add-only.md §1), applied to every ref-list
 * derive path: codec `decodeRefListIds`, the references processor's
 * `projectPropertyReferences`, and reprojection's `projectedRefsForField`.
 *
 * They all reduce to the same shape — decode an encoded ref-list value to its
 * derived ids — and share one hazard (#189): a single malformed element used
 * to throw the whole decode, the projection swallowed it, and the references
 * column was replaced with `[]`, silently deleting every backlink the field
 * contributed. The decode-facet contract is therefore:
 *   - one malformed element drops ONLY itself — the well-formed siblings derive
 *     **exactly**, with no extras and nothing coerced from the bad element;
 *   - a wrong-shape value yields `[]` and NEVER throws — a throw aborts the
 *     block's whole projection, which is how the partial failure escalated
 *     into a whole-field (and, fleet-wide, mass) strip.
 *
 * This does NOT exercise the *retain-on-absence* facet (§2) — that lives in
 * `reconcileDerived`'s `retain` path and is pinned by its own unit tests plus
 * the `latestRefProjectionSchema` absence branch.
 *
 * `derive` runs the path under test over a raw ref-list value and returns the
 * derived ref ids (map `BlockReference[] -> r.id` at the call site).
 */
export const assertRefListDeriveIsAddOnly = (
  derive: (refListValue: unknown) => readonly string[],
): void => {
  const sorted = (value: unknown) => [...derive(value)].sort()

  // Baseline: the well-formed elements derive exactly — no extras.
  expect(sorted(['valid-1', 'valid-2'])).toEqual(['valid-1', 'valid-2'])

  // One malformed element of each wrong shape drops ONLY itself: the result is
  // exactly the well-formed siblings — the bad element is neither retained nor
  // coerced into an id, and the siblings are never stripped alongside it.
  for (const bad of [42, null, {}, ['nested'], true]) {
    expect(sorted(['valid-1', bad, 'valid-2'])).toEqual(['valid-1', 'valid-2'])
  }

  // A wrong-shape (non-array) value yields [] and must NOT throw: a throw here
  // is what propagated up and stripped the whole field's derived refs.
  for (const wrong of ['not-an-array', 42, null, undefined, {}]) {
    expect(() => derive(wrong)).not.toThrow()
    expect(derive(wrong)).toEqual([])
  }
}
