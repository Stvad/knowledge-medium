import { canonicalizeChord, toChordArray } from "./canonicalizeChord.js";
//#region src/shortcuts/keybindingConflicts.ts
var contextsOverlap = (a, b) => a === b || a === "global" || b === "global";
var participantOf = (action) => ({
	actionId: action.id,
	context: action.context,
	description: action.description
});
/** All chord clashes across the supplied actions. Each returned entry
*  groups every action that participates in that chord-context overlap.
*  Stable order: chords sorted lexicographically, actions sorted by id. */
var findKeybindingConflicts = (actions) => {
	const byChord = /* @__PURE__ */ new Map();
	for (const action of actions) {
		if (!action.defaultBinding) continue;
		for (const chord of toChordArray(action.defaultBinding.keys)) {
			const key = canonicalizeChord(chord);
			const bucket = byChord.get(key) ?? {
				chord,
				actions: []
			};
			bucket.actions.push(action);
			byChord.set(key, bucket);
		}
	}
	const conflicts = [];
	for (const { chord, actions: candidates } of byChord.values()) {
		if (candidates.length < 2) continue;
		const participants = findOverlappingGroup(candidates);
		if (participants.length < 2) continue;
		conflicts.push({
			chord,
			actions: participants.map(participantOf).toSorted((a, b) => a.actionId.localeCompare(b.actionId))
		});
	}
	return conflicts.toSorted((a, b) => a.chord.localeCompare(b.chord));
};
/** From the candidates list, pick the largest subset whose contexts
*  all pairwise-overlap. With the current rule (same OR global) this
*  reduces to: include every candidate whose context is `global`, then
*  include candidates from whichever non-global context has the
*  highest count alongside them. Conservative — under-reports rather
*  than over-reports when contexts are heterogeneous. */
var findOverlappingGroup = (candidates) => {
	const globals = candidates.filter((a) => a.context === "global");
	const scoped = candidates.filter((a) => a.context !== "global");
	if (globals.length >= 2) return [...globals, ...scoped];
	if (globals.length === 1) {
		const biggest = pickBiggest(groupByContext(scoped));
		if (!biggest || biggest.length === 0) return [];
		return [...globals, ...biggest];
	}
	return pickBiggest(groupByContext(scoped)) ?? [];
};
var groupByContext = (actions) => {
	const out = /* @__PURE__ */ new Map();
	for (const action of actions) {
		const bucket = out.get(action.context) ?? [];
		bucket.push(action);
		out.set(action.context, bucket);
	}
	return out;
};
var pickBiggest = (buckets) => {
	let best;
	for (const bucket of buckets.values()) if (!best || bucket.length > best.length) best = bucket;
	return best;
};
//#endregion
export { contextsOverlap, findKeybindingConflicts };

//# sourceMappingURL=keybindingConflicts.js.map