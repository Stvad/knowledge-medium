//#region src/plugins/references/invalidation.ts
var REFERENCES_TARGET_INVALIDATION_CHANNEL = "references.target";
var emitReferenceTargetDiff = (before, after, emit) => {
	if (before.length === 0 && after.length === 0) return;
	const beforePairs = /* @__PURE__ */ new Map();
	for (const ref of before) beforePairs.set(`${ref.id}\u0000${ref.sourceField ?? ""}`, ref.id);
	const afterPairs = /* @__PURE__ */ new Map();
	for (const ref of after) afterPairs.set(`${ref.id}\u0000${ref.sourceField ?? ""}`, ref.id);
	const emitted = /* @__PURE__ */ new Set();
	for (const [key, id] of beforePairs) if (!afterPairs.has(key) && !emitted.has(id)) {
		emitted.add(id);
		emit(REFERENCES_TARGET_INVALIDATION_CHANNEL, id);
	}
	for (const [key, id] of afterPairs) if (!beforePairs.has(key) && !emitted.has(id)) {
		emitted.add(id);
		emit(REFERENCES_TARGET_INVALIDATION_CHANNEL, id);
	}
};
var emitSnapshotTargetDiff = (snapshot, emit) => {
	const beforeLive = !!snapshot.before && !snapshot.before.deleted;
	const afterLive = !!snapshot.after && !snapshot.after.deleted;
	emitReferenceTargetDiff(beforeLive ? snapshot.before?.references ?? [] : [], afterLive ? snapshot.after?.references ?? [] : [], emit);
};
var referencesInvalidationRule = {
	id: "references.target-invalidation",
	collectFromSnapshots: (snapshots, emit) => {
		for (const snapshot of snapshots.values()) emitSnapshotTargetDiff(snapshot, emit);
	}
};
//#endregion
export { REFERENCES_TARGET_INVALIDATION_CHANNEL, referencesInvalidationRule };

//# sourceMappingURL=invalidation.js.map