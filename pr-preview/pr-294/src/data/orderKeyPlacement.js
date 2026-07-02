import { keysBetween } from "./orderKey.js";
//#region src/data/orderKeyPlacement.ts
/** `n` ascending keys that sort IMMEDIATELY before `siblings[anchor]`. When the
*  anchor ties with its predecessor (no strict gap), re-key the anchor and its
*  tied successors up — preserving their order — to open the slot just above the
*  run key (which the tied predecessors keep). */
var keysImmediatelyBefore = async (tx, parentId, siblings, anchor, n) => {
	const anchorKey = siblings[anchor].orderKey;
	const prev = anchor > 0 ? siblings[anchor - 1] : void 0;
	if (prev === void 0 || prev.orderKey < anchorKey) return keysBetween(prev?.orderKey ?? null, anchorKey, n);
	let runEnd = anchor;
	while (runEnd + 1 < siblings.length && siblings[runEnd + 1].orderKey === anchorKey) runEnd++;
	const gap = keysBetween(anchorKey, runEnd + 1 < siblings.length ? siblings[runEnd + 1].orderKey : null, n + (runEnd - anchor + 1));
	for (let i = anchor; i <= runEnd; i++) await tx.move(siblings[i].id, {
		parentId,
		orderKey: gap[n + (i - anchor)]
	});
	return gap.slice(0, n);
};
/** `n` ascending keys that sort IMMEDIATELY after `siblings[anchor]`. When the
*  anchor ties with its next sibling, re-key the tied successors up to open the
*  slot; the anchor keeps its key. */
var keysImmediatelyAfter = async (tx, parentId, siblings, anchor, n) => {
	const anchorKey = siblings[anchor].orderKey;
	const next = anchor + 1 < siblings.length ? siblings[anchor + 1] : void 0;
	if (next === void 0 || anchorKey < next.orderKey) return keysBetween(anchorKey, next?.orderKey ?? null, n);
	let runEnd = anchor + 1;
	while (runEnd + 1 < siblings.length && siblings[runEnd + 1].orderKey === anchorKey) runEnd++;
	const gap = keysBetween(anchorKey, runEnd + 1 < siblings.length ? siblings[runEnd + 1].orderKey : null, n + (runEnd - anchor));
	for (let i = anchor + 1; i <= runEnd; i++) await tx.move(siblings[i].id, {
		parentId,
		orderKey: gap[n + (i - anchor - 1)]
	});
	return gap.slice(0, n);
};
/** Single-key convenience wrapper for {@link keysImmediatelyBefore}. */
var keyImmediatelyBefore = async (tx, parentId, siblings, anchor) => (await keysImmediatelyBefore(tx, parentId, siblings, anchor, 1))[0];
/** Single-key convenience wrapper for {@link keysImmediatelyAfter}. */
var keyImmediatelyAfter = async (tx, parentId, siblings, anchor) => (await keysImmediatelyAfter(tx, parentId, siblings, anchor, 1))[0];
//#endregion
export { keyImmediatelyAfter, keyImmediatelyBefore, keysImmediatelyAfter, keysImmediatelyBefore };

//# sourceMappingURL=orderKeyPlacement.js.map