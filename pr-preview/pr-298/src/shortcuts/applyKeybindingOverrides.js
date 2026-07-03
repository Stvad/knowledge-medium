import { isKeyOverrideUnbound } from "./keybindingOverrides.js";
import { toChordArray } from "./canonicalizeChord.js";
//#region src/shortcuts/applyKeybindingOverrides.ts
var fromChordArray = (chords) => chords.length === 1 ? chords[0] : chords;
var contextsOverlap = (a, b) => a === b || a === "global" || b === "global";
var matchesAction = (override, action) => override.actionId === action.id && (override.context === void 0 || override.context === action.context);
/** Resolve an override's effective context: explicit `context` wins,
*  otherwise fall back to the target action's own context (looked up
*  by id in the supplied map). Returns null if neither is available —
*  e.g. an override targeting an id no action declares. */
var effectiveContextFor = (override, actionsById) => {
	if (override.context !== void 0) return override.context;
	return actionsById.get(override.actionId) ?? null;
};
var applyKeybindingOverrides = (actions, overrides) => {
	if (overrides.length === 0) return actions;
	const actionContextById = /* @__PURE__ */ new Map();
	for (const action of actions) if (!actionContextById.has(action.id)) actionContextById.set(action.id, action.context);
	const claimedByChord = /* @__PURE__ */ new Map();
	for (const override of overrides) {
		if (isKeyOverrideUnbound(override.binding)) continue;
		const ctx = effectiveContextFor(override, actionContextById);
		if (ctx === null) continue;
		for (const chord of toChordArray(override.binding.keys)) {
			let set = claimedByChord.get(chord);
			if (!set) {
				set = /* @__PURE__ */ new Set();
				claimedByChord.set(chord, set);
			}
			set.add(ctx);
		}
	}
	return actions.map((action) => applyToAction(action, overrides, claimedByChord));
};
var applyToAction = (action, overrides, claimedByChord) => {
	let direct;
	for (const override of overrides) if (matchesAction(override, action)) direct = override;
	if (direct) {
		if (isKeyOverrideUnbound(direct.binding)) return {
			...action,
			defaultBinding: void 0
		};
		return {
			...action,
			defaultBinding: {
				...action.defaultBinding ?? {},
				keys: direct.binding.keys
			}
		};
	}
	if (!action.defaultBinding) return action;
	const defaultChords = toChordArray(action.defaultBinding.keys);
	const survivors = defaultChords.filter((chord) => {
		const claimingContexts = claimedByChord.get(chord);
		if (!claimingContexts) return true;
		for (const otherCtx of claimingContexts) if (contextsOverlap(otherCtx, action.context)) return false;
		return true;
	});
	if (survivors.length === defaultChords.length) return action;
	if (survivors.length === 0) return {
		...action,
		defaultBinding: void 0
	};
	return {
		...action,
		defaultBinding: {
			...action.defaultBinding,
			keys: fromChordArray(survivors)
		}
	};
};
//#endregion
export { applyKeybindingOverrides };

//# sourceMappingURL=applyKeybindingOverrides.js.map