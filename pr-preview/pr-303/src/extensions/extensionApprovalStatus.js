import { BatchableKeyedStore } from "./batchableKeyedStore.js";
import { createContext, useContext, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/extensions/extensionApprovalStatus.tsx
/**
* Plain non-React store for the device-local trust status of enabled
* extension blocks (issue #67). Populated by the dynamic-extensions loader
* during runtime resolution:
*   - `needs-approval`: enabled by intent (here or on another device) but
*     never approved on THIS device — nothing runs until the user reviews
*     and approves the live source ("Enable here").
*   - `update-available`: approved, but the live source has drifted from
*     the approved pin — the pinned version keeps running; "Update"
*     re-approves the live source.
*
* Mirrors `extensionLoadErrors.tsx`: the React provider is a thin wrapper
* so the state machine is unit-testable without mounting a tree.
*/
var ExtensionApprovalStatusStore = class extends BatchableKeyedStore {
	constructor() {
		super("ExtensionApprovalStatus");
	}
	report = (blockId, status) => this.set(blockId, status);
	clear = (blockId) => this.delete(blockId);
};
var ExtensionApprovalStatusContext = createContext({ store: new ExtensionApprovalStatusStore() });
var ExtensionApprovalStatusProvider = (t0) => {
	const $ = c(7);
	const { children, store } = t0;
	let t1;
	if ($[0] !== store) {
		t1 = store ?? new ExtensionApprovalStatusStore();
		$[0] = store;
		$[1] = t1;
	} else t1 = $[1];
	const ownStore = t1;
	let t2;
	if ($[2] !== ownStore) {
		t2 = { store: ownStore };
		$[2] = ownStore;
		$[3] = t2;
	} else t2 = $[3];
	const value = t2;
	let t3;
	if ($[4] !== children || $[5] !== value) {
		t3 = /* @__PURE__ */ jsx(ExtensionApprovalStatusContext.Provider, {
			value,
			children
		});
		$[4] = children;
		$[5] = value;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
};
var useStore = () => {
	return useContext(ExtensionApprovalStatusContext).store;
};
/** Subscribe to a single block's trust status (undefined = running
*  as-authored / nothing to surface). */
var useExtensionApprovalStatus = (blockId) => {
	const $ = c(4);
	const store = useStore();
	let t0;
	let t1;
	if ($[0] !== blockId || $[1] !== store) {
		t0 = () => store.getSnapshot().get(blockId);
		t1 = () => store.getSnapshot().get(blockId);
		$[0] = blockId;
		$[1] = store;
		$[2] = t0;
		$[3] = t1;
	} else {
		t0 = $[2];
		t1 = $[3];
	}
	return useSyncExternalStore(store.subscribe, t0, t1);
};
/** Subscribe to the whole trust-status map (blockId → status). Used by the
*  global prompt surface, which needs every pending extension at once rather
*  than a single row. The store returns a referentially-stable Map between
*  changes, so this is safe to drive a `useMemo`/`useSyncExternalStore`. */
var useExtensionApprovalStatuses = () => {
	const store = useStore();
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};
//#endregion
export { ExtensionApprovalStatusProvider, ExtensionApprovalStatusStore, useExtensionApprovalStatus, useExtensionApprovalStatuses };

//# sourceMappingURL=extensionApprovalStatus.js.map