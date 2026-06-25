/**
 * Derived-data reconciliation — the runtime half of the "derived data is
 * add-only / retain-on-source" contract (docs/contracts/derived-data-add-only.md).
 *
 * Derived columns (backlinks / `references_json`, …) are recomputed from a
 * source and written back. The hazard the contract guards against is a
 * recompute that came out *partial* — a deriver was absent (plugin toggled
 * off / schema not loaded) or an input failed to decode — being treated as
 * authoritative and replace-written, silently deleting derived data that the
 * source still implies. (That class wiped ~10k SRS `next-review-date`
 * backlinks; see the contract doc for the incident history.)
 *
 * `reconcileDerived` is the chokepoint the backlink-deriving sites route their
 * write through, so "recompute never reduces the derived set for a
 * present/unchanged source key" is enforced in one audited place rather than
 * re-hand-rolled per site. Routed today: reprojection (`repo.ts`), the
 * references processor, and the roam importer's reference rebuild
 * (`referencesWithProjectedProperties`, `src/plugins/roam-import/import.ts`) —
 * see docs/contracts/derived-data-add-only.md.
 */

import type { BlockReference } from './blockData'

export interface ReconcileDerivedArgs<E> {
  /** The derived elements currently stored on the row. */
  prior: readonly E[]
  /** The freshly recomputed derived elements. MAY be partial — a deriver
   *  was absent, or one input element failed to decode — which is exactly
   *  why prior elements are retained rather than blindly replaced. */
  recomputed: readonly E[]
  /** Stable identity of a derived element (dedup against `recomputed` +
   *  retain matching). */
  keyOf: (element: E) => string
  /** Predicate over a PRIOR element: retain it even though `recomputed`
   *  didn't reproduce it. Return true only when the element's source is
   *  present-but-un-recomputable (deriver absent / not loaded) — never for a
   *  source that genuinely changed or was removed: that removal is the
   *  legitimate, value-driven drop the contract still allows. Defaults to
   *  always-retain (pure add-only — e.g. reprojection, which fires on a
   *  schema change while the block's *values* are static, so recompute can
   *  only add). */
  retain?: (priorElement: E) => boolean
}

/** Merge `recomputed` over `prior` such that the result never *reduces* the
 *  derived set for a source key the recompute couldn't re-derive. Returns
 *  `recomputed` plus every prior element that (a) the recompute didn't
 *  reproduce and (b) `retain` keeps. Pure; order is recomputed-first then
 *  retained-prior (derived columns normalise on write, so callers must not
 *  depend on element order). */
export const reconcileDerived = <E>({
  prior,
  recomputed,
  keyOf,
  retain = () => true,
}: ReconcileDerivedArgs<E>): E[] => {
  const recomputedKeys = new Set(recomputed.map(keyOf))
  const retainedPrior = prior.filter(
    element => !recomputedKeys.has(keyOf(element)) && retain(element),
  )
  return [...recomputed, ...retainedPrior]
}

/** NUL — the separator the projection helpers join `(sourceField, id)` keys
 *  on (a content reference's empty `sourceField` can't collide with a real
 *  field name). Built with `String.fromCharCode` to keep the raw byte out of
 *  the source text. */
const REF_KEY_SEPARATOR = String.fromCharCode(0)

/** Identity of a derived block reference for `reconcileDerived` dedup/retain:
 *  `(sourceField, id)` joined on NUL. A content reference has an empty
 *  `sourceField`; a property-derived reference carries the owning field.
 *  Matches the key the projection helpers dedup on. */
export const derivedRefKey = (
  ref: Pick<BlockReference, 'id' | 'sourceField'>,
): string => `${ref.sourceField ?? ''}${REF_KEY_SEPARATOR}${ref.id}`
