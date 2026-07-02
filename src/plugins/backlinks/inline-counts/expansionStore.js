import { CallbackSet } from "../../../utils/callbackSet.js";
import { useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/backlinks/inline-counts/expansionStore.ts
/** Which blocks have their inline backlinks manually expanded, this
*  session. Deliberately ephemeral module state (a `Set` of block ids),
*  NOT a persisted block property: expansion is a transient view action,
*  and writing it to block data would pollute history + sync traffic for
*  every block the user peeks at. Roam's inline references expansion is
*  likewise session-scoped.
*
*  Keyed by block id alone — ids are globally unique, and the set lives
*  only for the tab's lifetime, so no workspace qualifier is needed. */
var expanded = /* @__PURE__ */ new Set();
var listeners = new CallbackSet("backlink-expansion");
var subscribe = (listener) => listeners.add(listener);
var toggleBacklinkExpansion = (blockId) => {
	if (expanded.has(blockId)) expanded.delete(blockId);
	else expanded.add(blockId);
	listeners.notify();
};
/** Reactive: is this block's inline backlinks section expanded? */
var useBacklinkExpansion = (blockId) => {
	const $ = c(2);
	let t0;
	if ($[0] !== blockId) {
		t0 = () => expanded.has(blockId);
		$[0] = blockId;
		$[1] = t0;
	} else t0 = $[1];
	return useSyncExternalStore(subscribe, t0);
};
//#endregion
export { toggleBacklinkExpansion, useBacklinkExpansion };

//# sourceMappingURL=expansionStore.js.map