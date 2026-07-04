//#region src/utils/array.ts
/**
* Mutate `list` so its contents (order preserved) match `desired`.
*
* @param list     The mutable list to update
* @param desired  The target contents
* @param keyOf    How to obtain a unique key from an item
*/
function reconcileList(list, desired, keyOf) {
	const want = new Set(desired.map(keyOf));
	const kept = /* @__PURE__ */ new Set();
	for (let i = list.length - 1; i >= 0; i--) {
		const k = keyOf(list[i]);
		if (!want.has(k)) list.splice(i, 1);
		else kept.add(k);
	}
	for (const item of desired) {
		const k = keyOf(item);
		if (!kept.has(k)) list.push(item);
	}
}
/**
* Trim each entry, drop empties, and de-duplicate — first occurrence wins,
* input order preserved. Non-array inputs and non-string entries are skipped,
* so this doubles as defensive coercion for untrusted config values (e.g. a
* codec decoding a stored list). Note this trims; for verbatim de-duplication
* (no trimming) keep a dedicated helper.
*/
var uniqueStrings = (value) => {
	if (!Array.isArray(value)) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
};
//#endregion
export { reconcileList, uniqueStrings };

//# sourceMappingURL=array.js.map