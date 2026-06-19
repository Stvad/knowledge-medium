import { expect } from 'vitest'

/**
 * Shared assertion for the "derived data is add-only / retain-on-source"
 * contract (docs/contracts/derived-data-add-only.md), applied to every
 * ref-list derive path: codec `decodeRefListIds`, the references processor's
 * `projectPropertyReferences`, reprojection's `projectedRefsForField`, and the
 * importer rebuild (which reuses `projectPropertyReferences`).
 *
 * They all reduce to the same shape — decode an encoded ref-list value to its
 * derived ids — and share one hazard (#189): a single malformed element used
 * to throw the whole decode, the projection swallowed it, and the references
 * column was replaced with `[]`, silently deleting every backlink the field
 * contributed. The contract is therefore:
 *   - one malformed element drops ONLY itself; well-formed siblings survive;
 *   - a wrong-shape value yields `[]` and NEVER throws — a throw aborts the
 *     block's whole projection, which is how the partial failure escalated
 *     into a whole-field (and, fleet-wide, mass) strip.
 *
 * `derive` runs the path under test over a raw ref-list value and returns the
 * derived ref ids (map `BlockReference[] -> r.id` at the call site).
 */
export const assertRefListDeriveIsAddOnly = (
  derive: (refListValue: unknown) => readonly string[],
): void => {
  // Baseline: well-formed elements all derive.
  expect(derive(['valid-1', 'valid-2'])).toEqual(
    expect.arrayContaining(['valid-1', 'valid-2']),
  )

  // One malformed element of each wrong shape drops only itself — the
  // well-formed siblings are retained, never stripped to [].
  for (const bad of [42, null, {}, ['nested'], true]) {
    const ids = derive(['valid-1', bad, 'valid-2'])
    expect(ids).toEqual(expect.arrayContaining(['valid-1', 'valid-2']))
    expect(ids).not.toContain(bad)
  }

  // A wrong-shape (non-array) value yields [] and must NOT throw: a throw here
  // is what propagated up and stripped the whole field's derived refs.
  for (const wrong of ['not-an-array', 42, null, undefined, {}]) {
    expect(() => derive(wrong)).not.toThrow()
    expect(derive(wrong)).toEqual([])
  }
}
