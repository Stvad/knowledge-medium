//#region src/data/api/derivedData.ts
/** Merge `recomputed` over `prior` such that the result never *reduces* the
*  derived set for a source key the recompute couldn't re-derive. Returns
*  `recomputed` plus every prior element that (a) the recompute didn't
*  reproduce and (b) `retain` keeps. Pure; order is recomputed-first then
*  retained-prior (derived columns normalise on write, so callers must not
*  depend on element order). */
var reconcileDerived = ({ prior, recomputed, keyOf, retain = () => true }) => {
	const recomputedKeys = new Set(recomputed.map(keyOf));
	const retainedPrior = prior.filter((element) => !recomputedKeys.has(keyOf(element)) && retain(element));
	return [...recomputed, ...retainedPrior];
};
/** NUL — the separator the projection helpers join `(sourceField, id)` keys
*  on (a content reference's empty `sourceField` can't collide with a real
*  field name). Built with `String.fromCharCode` to keep the raw byte out of
*  the source text. */
var REF_KEY_SEPARATOR = String.fromCharCode(0);
/** Identity of a derived block reference for `reconcileDerived` dedup/retain:
*  `(sourceField, id)` joined on NUL. A content reference has an empty
*  `sourceField`; a property-derived reference carries the owning field.
*  Matches the key the projection helpers dedup on. */
var derivedRefKey = (ref) => `${ref.sourceField ?? ""}${REF_KEY_SEPARATOR}${ref.id}`;
//#endregion
export { derivedRefKey, reconcileDerived };

//# sourceMappingURL=derivedData.js.map