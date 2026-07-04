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
/** Fold a later tx's snapshots into an earlier one, in place — the
*  cross-tx analog of {@link recordWrite}'s within-tx rule: per block,
*  keep the EARLIEST `before` (target's, when both touched the id) and
*  take the LATEST `after` (incoming's). Used by `UndoManager.record`
*  to merge same-group entries (issue #306) so one undo entry reverts
*  a whole multi-tx composite operation. */
var mergeSnapshotsInto = (target, incoming) => {
	for (const [id, snap] of incoming) recordWrite(target, id, snap.before, snap.after);
};
/** Look up an own-write for a given id. Used by `tx.peek` to see this
*  tx's pending writes before the cache. */
var peekSnapshot = (snapshots, id) => {
	const entry = snapshots.get(id);
	return entry === void 0 ? void 0 : entry.after;
};
//#endregion
export { mergeSnapshotsInto, newSnapshotsMap, peekSnapshot, recordWrite };

//# sourceMappingURL=txSnapshots.js.map