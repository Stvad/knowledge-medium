import { CallbackSet } from "../utils/callbackSet.js";
import { clientLocalSettings } from "../utils/ClientLocalSettings.js";
import { useSyncExternalStore } from "react";
//#region src/extensions/extensionPromptDismissals.ts
/**
* Device-local, per-extension record of "I've seen this prompt and don't
* want to be nudged about it (for now)."
*
* Keyed by `blockId → the live source hash that was dismissed`. Two
* properties matter, and both are the fix for the reported bug (dismissing
* one extension's prompt hid a different one, and didn't survive a reload):
*
*   - **Per-blockId.** Dismissing extension A records only A. B is never
*     touched, so the two prompts are independent.
*   - **Persisted + hash-scoped.** The dismissal is written to localStorage
*     so it survives a reload, but it's pinned to the *source version* that
*     was showing. If the extension's live source later changes (new hash),
*     the dismissal no longer matches and the prompt re-surfaces — a fresh
*     update still nudges, an already-declined one stays quiet.
*
* Device-local (localStorage), matching where the underlying approval trust
* grant lives — a dismissal is a per-device UI choice, not synced intent.
*
* Mirrors the settings surface: the extension still appears in Extensions
* settings with a working Enable/Update button regardless of dismissal —
* dismissing only silences the *global* toast + status-chip nudge.
*/
var STORAGE_KEY = "extensions.prompt-dismissals";
var decode = (raw) => {
	const out = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [blockId, hash] of Object.entries(raw)) if (typeof hash === "string") out[blockId] = hash;
	return out;
};
var sameDismissals = (a, b) => {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	for (const key of aKeys) if (a[key] !== b[key]) return false;
	return true;
};
var ExtensionPromptDismissalStore = class {
	state;
	listeners = new CallbackSet("ExtensionPromptDismissals");
	constructor(storage = clientLocalSettings) {
		this.storage = storage;
		this.state = decode(storage.get(STORAGE_KEY, null));
	}
	getSnapshot = () => this.state;
	subscribe = (listener) => this.listeners.add(listener);
	/** True only when this exact (blockId, liveHash) has been dismissed. A
	*  changed source (different liveHash) is NOT dismissed. */
	isDismissed = (blockId, liveHash) => this.state[blockId] === liveHash;
	/** Record a dismissal for one extension, pinned to its current live hash.
	*  Per-blockId — never affects another extension's prompt. */
	dismiss = (blockId, liveHash) => {
		if (this.state[blockId] === liveHash) return;
		this.state = {
			...this.state,
			[blockId]: liveHash
		};
		this.persist();
		this.notify();
	};
	/** Drop a dismissal — e.g. once the extension is enabled/approved, so a
	*  later update can nudge again and localStorage doesn't accumulate stale
	*  entries. No-op when nothing was dismissed. */
	clear = (blockId) => {
		if (!(blockId in this.state)) return;
		const next = { ...this.state };
		delete next[blockId];
		this.state = next;
		this.persist();
		this.notify();
	};
	/** Re-read from storage. Used by the cross-tab `storage` listener (and
	*  tests) so a dismissal in another tab reflects here. No-ops (no notify,
	*  no fresh snapshot) when the stored value is unchanged — mirrors the
	*  equality guards in `dismiss`/`clear` so a redundant `storage` event
	*  doesn't churn subscribers. */
	reloadFromStorage = () => {
		const next = decode(this.storage.get(STORAGE_KEY, null));
		if (sameDismissals(next, this.state)) return;
		this.state = next;
		this.notify();
	};
	persist() {
		this.storage.set(STORAGE_KEY, this.state);
	}
	notify() {
		this.listeners.notify();
	}
};
var extensionPromptDismissals = new ExtensionPromptDismissalStore();
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
	if (event.key === STORAGE_KEY) extensionPromptDismissals.reloadFromStorage();
});
var useExtensionPromptDismissals = () => {
	return useSyncExternalStore(extensionPromptDismissals.subscribe, extensionPromptDismissals.getSnapshot, extensionPromptDismissals.getSnapshot);
};
//#endregion
export { ExtensionPromptDismissalStore, extensionPromptDismissals, useExtensionPromptDismissals };

//# sourceMappingURL=extensionPromptDismissals.js.map