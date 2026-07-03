import { CallbackSet } from "../utils/callbackSet.js";
//#region src/extensions/batchableKeyedStore.ts
/**
* Base for the small non-React "keyed map + CallbackSet" stores the runtime
* resolve populates (extension trust statuses, extension load errors). They
* were byte-for-byte identical apart from the value type and two method
* names, so the shared machinery lives here.
*
* The point of the base (beyond dedup) is the BATCH mode: `AppRuntimeProvider`
* re-resolves on every `refreshAppRuntime()`, and the naive shape — `reset()`
* to empty, then dribble the loader's per-block re-reports in after an async
* gap — briefly blanked the map, which flickered the surfaces that read it
* (global prompt toasts + status chip, row status icons). A batch buffers the
* cycle's writes and publishes them as ONE atomic old→new transition:
*   - `beginBatch()` opens an EMPTY buffer (so anything no longer reported
*     drops out on commit — same end state as `reset()`, just deferred).
*   - `set`/`delete` during a batch write to the buffer and DON'T notify.
*   - `commitBatch()` swaps the buffer into the live map, one notification.
*   - `abandonBatch()` drops the buffer (cancelled / errored resolve).
*
* Subclasses expose domain-named methods (`report`/`clear`,
* `reportError`/`clearError`) that delegate to the protected `set`/`delete`,
* so call sites and hooks are unchanged. Every public member is a bound arrow
* property, so they survive destructuring (e.g. `const {reportError} = store`).
*/
var BatchableKeyedStore = class {
	map = /* @__PURE__ */ new Map();
	batch = null;
	listeners;
	constructor(label) {
		this.listeners = new CallbackSet(label);
	}
	getSnapshot = () => this.map;
	subscribe = (listener) => this.listeners.add(listener);
	/** Open a batch: subsequent set/delete buffer without notifying until
	*  commitBatch. The buffer starts empty and is rebuilt from this cycle's
	*  writes. Discards any in-progress batch (a superseded resolve). */
	beginBatch = () => {
		this.batch = /* @__PURE__ */ new Map();
	};
	/** Publish the buffered batch as ONE notification (even when it clears the
	*  map). No-op if no batch is open. */
	commitBatch = () => {
		if (this.batch === null) return;
		this.map = this.batch;
		this.batch = null;
		this.listeners.notify();
	};
	/** Drop the buffer without publishing (cancelled / errored resolve). */
	abandonBatch = () => {
		this.batch = null;
	};
	set = (key, value) => {
		if (this.batch !== null) {
			this.batch.set(key, value);
			return;
		}
		const next = new Map(this.map);
		next.set(key, value);
		this.map = next;
		this.listeners.notify();
	};
	delete = (key) => {
		if (this.batch !== null) {
			this.batch.delete(key);
			return;
		}
		if (!this.map.has(key)) return;
		const next = new Map(this.map);
		next.delete(key);
		this.map = next;
		this.listeners.notify();
	};
	/** Clear the live map (and abandon any open batch). Notifies unless already
	*  empty. */
	reset = () => {
		this.batch = null;
		if (this.map.size === 0) return;
		this.map = /* @__PURE__ */ new Map();
		this.listeners.notify();
	};
};
//#endregion
export { BatchableKeyedStore };

//# sourceMappingURL=batchableKeyedStore.js.map