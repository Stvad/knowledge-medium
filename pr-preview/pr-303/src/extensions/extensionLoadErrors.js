import { CallbackSet } from "../utils/callbackSet.js";
import { createContext, useContext, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/extensions/extensionLoadErrors.tsx
/**
* Plain non-React store for extension load errors. The React provider
* is a thin wrapper around this so the state machine itself is unit-
* testable without mounting a component tree.
*/
var ExtensionLoadErrorStore = class {
	errors = /* @__PURE__ */ new Map();
	batch = null;
	listeners = new CallbackSet("ExtensionLoadErrors");
	getSnapshot = () => this.errors;
	subscribe = (listener) => this.listeners.add(listener);
	/** Open a batch. Subsequent reportError/clearError buffer without notifying
	*  until commitBatch. The buffer starts EMPTY (like reset()) and is rebuilt
	*  from this resolve's reports. Discards any in-progress batch. */
	beginBatch = () => {
		this.batch = /* @__PURE__ */ new Map();
	};
	/** Publish the buffered batch as ONE notification. No-op if none open. */
	commitBatch = () => {
		if (this.batch === null) return;
		this.errors = this.batch;
		this.batch = null;
		this.listeners.notify();
	};
	/** Drop the buffer without publishing (cancelled / errored resolve). */
	abandonBatch = () => {
		this.batch = null;
	};
	reportError = (blockId, error) => {
		if (this.batch !== null) {
			this.batch.set(blockId, error);
			return;
		}
		const next = new Map(this.errors);
		next.set(blockId, error);
		this.errors = next;
		this.listeners.notify();
	};
	clearError = (blockId) => {
		if (this.batch !== null) {
			this.batch.delete(blockId);
			return;
		}
		if (!this.errors.has(blockId)) return;
		const next = new Map(this.errors);
		next.delete(blockId);
		this.errors = next;
		this.listeners.notify();
	};
	reset = () => {
		this.batch = null;
		if (this.errors.size === 0) return;
		this.errors = /* @__PURE__ */ new Map();
		this.listeners.notify();
	};
};
var ExtensionLoadErrorsContext = createContext({ store: new ExtensionLoadErrorStore() });
var ExtensionLoadErrorsProvider = (t0) => {
	const $ = c(7);
	const { children, store } = t0;
	let t1;
	if ($[0] !== store) {
		t1 = store ?? new ExtensionLoadErrorStore();
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
		t3 = /* @__PURE__ */ jsx(ExtensionLoadErrorsContext.Provider, {
			value,
			children
		});
		$[4] = children;
		$[5] = value;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
};
var useExtensionLoadErrorsStore = () => {
	return useContext(ExtensionLoadErrorsContext).store;
};
var useExtensionLoadErrors = () => {
	const $ = c(5);
	const store = useExtensionLoadErrorsStore();
	const errors = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	let t0;
	if ($[0] !== errors || $[1] !== store.clearError || $[2] !== store.reportError || $[3] !== store.reset) {
		t0 = {
			errors,
			reportError: store.reportError,
			clearError: store.clearError,
			reset: store.reset
		};
		$[0] = errors;
		$[1] = store.clearError;
		$[2] = store.reportError;
		$[3] = store.reset;
		$[4] = t0;
	} else t0 = $[4];
	return t0;
};
var useExtensionLoadError = (blockId) => {
	const $ = c(4);
	const store = useExtensionLoadErrorsStore();
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
//#endregion
export { ExtensionLoadErrorStore, ExtensionLoadErrorsProvider, useExtensionLoadError, useExtensionLoadErrors };

//# sourceMappingURL=extensionLoadErrors.js.map