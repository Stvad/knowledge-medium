//#region src/data/internals/jsonCanonical.ts
/**
* Canonical JSON value helpers — the single source of truth for "are these
* two values equal once persisted as JSON?".
*
* Block properties/references are stored via `JSON.stringify(...)`, so the
* equivalence that matters everywhere downstream is the persisted-JSON one:
*   - object key order is irrelevant (storage round-trips either order), and
*   - `NaN` / `undefined` collapse to `null` (JSON has no other encoding).
*
* `stableJsonValue` canonicalizes by sorting object keys recursively;
* `jsonValuesEqual` compares two values under that canonical form. The tx
* engine uses these for no-op detection; `mergeProperties` uses
* `stableJsonValue` to key its list dedupe so a merge never persists a value
* the storage layer would consider a duplicate.
*/
var isPlainObject = (value) => Object.prototype.toString.call(value) === "[object Object]";
var stableJsonValue = (value) => {
	if (Array.isArray(value)) return value.map(stableJsonValue);
	if (!isPlainObject(value)) return value;
	const out = {};
	for (const key of Object.keys(value).sort()) Object.defineProperty(out, key, {
		value: stableJsonValue(value[key]),
		enumerable: true,
		writable: true,
		configurable: true
	});
	return out;
};
var jsonValuesEqual = (a, b) => JSON.stringify(stableJsonValue(a)) === JSON.stringify(stableJsonValue(b));
//#endregion
export { jsonValuesEqual, stableJsonValue };

//# sourceMappingURL=jsonCanonical.js.map