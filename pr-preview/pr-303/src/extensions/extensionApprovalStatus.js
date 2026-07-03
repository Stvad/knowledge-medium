import { CallbackSet } from "../utils/callbackSet.js";
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
var ExtensionApprovalStatusStore = class {
	statuses = /* @__PURE__ */ new Map();
	batch = null;
	listeners = new CallbackSet("ExtensionApprovalStatus");
	getSnapshot = () => this.statuses;
	subscribe = (listener) => this.listeners.add(listener);
	/** Open a batch. Subsequent report/clear buffer without notifying until
	*  commitBatch. The buffer starts EMPTY (like reset()) and is rebuilt from
	*  this resolve's reports — so a block that's no longer pending is simply
	*  not re-reported and drops out on commit. Discards any in-progress batch
	*  (a superseded resolve). */
	beginBatch = () => {
		this.batch = /* @__PURE__ */ new Map();
	};
	/** Publish the buffered batch as ONE notification (even when it clears the
	*  map). No-op if no batch is open. */
	commitBatch = () => {
		if (this.batch === null) return;
		this.statuses = this.batch;
		this.batch = null;
		this.listeners.notify();
	};
	/** Drop the buffer without publishing (cancelled / errored resolve). */
	abandonBatch = () => {
		this.batch = null;
	};
	report = (blockId, status) => {
		if (this.batch !== null) {
			this.batch.set(blockId, status);
			return;
		}
		const next = new Map(this.statuses);
		next.set(blockId, status);
		this.statuses = next;
		this.listeners.notify();
	};
	clear = (blockId) => {
		if (this.batch !== null) {
			this.batch.delete(blockId);
			return;
		}
		if (!this.statuses.has(blockId)) return;
		const next = new Map(this.statuses);
		next.delete(blockId);
		this.statuses = next;
		this.listeners.notify();
	};
	reset = () => {
		this.batch = null;
		if (this.statuses.size === 0) return;
		this.statuses = /* @__PURE__ */ new Map();
		this.listeners.notify();
	};
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