//#region src/data/internals/txSnapshots.ts
var newSnapshotsMap = () => /* @__PURE__ */ new Map();
/** Record a write. If this is the first touch of `id`, `before` is the
*  passed-in current state (the engine SELECTed it just before issuing
*  the write). On subsequent writes, `before` is preserved and only
*  `after` is updated. */
var recordWrite = (snapshots, id, before, after) => {
	const existing = snapshots.get(id);
	if (existing) snapshots.set(id, {
		before: existing.before,
		after
	});
	else snapshots.set(id, {
		before,
		after
	});
};
/** Look up an own-write for a given id. Used by `tx.peek` to see this
*  tx's pending writes before the cache. */
var peekSnapshot = (snapshots, id) => {
	const entry = snapshots.get(id);
	return entry === void 0 ? void 0 : entry.after;
};
//#endregion
export { newSnapshotsMap, peekSnapshot, recordWrite };

//# sourceMappingURL=txSnapshots.js.map