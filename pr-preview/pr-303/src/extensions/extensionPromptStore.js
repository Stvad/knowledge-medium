import { CallbackSet } from "../utils/callbackSet.js";
//#region src/extensions/extensionPromptStore.ts
/**
* Publish point that bridges the per-provider approval store into the global
* status-chip diagnostic.
*
* The trust statuses live in a per-`AppRuntimeProvider` `ExtensionApproval-
* StatusStore` (recreated per workspace, read via React context). The status
* chip's diagnostic source, by contrast, is a static facet contribution with
* no React context to reach that store. So the driver mount (which DOES have
* the context) computes the active prompt set and publishes it here; the
* diagnostic reads this singleton.
*
* `activeExtensionPrompts` is the pure reducer both surfaces share.
*/
/**
* Reduce the raw trust-status map to the prompts that should surface
* globally: every enabled-but-not-running extension, MINUS the ones the user
* has dismissed for this exact source version.
*
* The dismissal check is `dismissals[blockId] === status.liveHash`, keyed per
* blockId — this is the fix for the mis-keyed dismissal: dismissing extension
* A filters ONLY A (and only while A's source is unchanged); B is never
* affected.
*/
var activeExtensionPrompts = (statuses, dismissals) => {
	const out = [];
	for (const [blockId, status] of statuses) {
		if (dismissals[blockId] === status.liveHash) continue;
		out.push({
			blockId,
			name: status.name,
			kind: status.kind,
			liveHash: status.liveHash
		});
	}
	return out;
};
var samePrompts = (a, b) => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.blockId !== y.blockId || x.kind !== y.kind || x.liveHash !== y.liveHash || x.name !== y.name) return false;
	}
	return true;
};
var ExtensionPromptStore = class {
	prompts = [];
	listeners = new CallbackSet("ExtensionPromptStore");
	getSnapshot = () => this.prompts;
	subscribe = (listener) => this.listeners.add(listener);
	/** Replace the published set. Dedupes by content so the snapshot ref stays
	*  referentially stable (a `useSyncExternalStore` requirement) whenever the
	*  driver re-publishes an unchanged set. */
	set = (next) => {
		if (samePrompts(this.prompts, next)) return;
		this.prompts = next;
		this.listeners.notify();
	};
};
var extensionPromptStore = new ExtensionPromptStore();
//#endregion
export { activeExtensionPrompts, extensionPromptStore };

//# sourceMappingURL=extensionPromptStore.js.map