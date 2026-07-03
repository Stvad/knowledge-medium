import { CallbackSet } from "./callbackSet.js";
//#region src/utils/toggleStore.ts
/**
* Tiny module-level open/closed store for a globally-mounted UI surface
* (command palette, find-replace, quick-find, left sidebar). The surface
* is mounted once via `appMountsFacet` and reads `isOpen()` with
* `useSyncExternalStore`; actions and header buttons flip it directly.
*
* This is the typed replacement for the old `window.CustomEvent` toggle
* bus — same single-instance, global semantics, but no stringly event
* names and no manual add/removeEventListener lifecycle. It's the same
* mechanism the app's own `DialogHost` uses for the dialog queue, and
* the one the extension authoring lint now blesses. Cross-plugin /
* external callers reach a surface through its action id
* (`runActionById`), never by importing the store.
*/
var createToggleStore = (label) => {
	let open = false;
	const subscribers = new CallbackSet(label);
	const set = (next) => {
		if (next === open) return;
		open = next;
		subscribers.notify();
	};
	return {
		isOpen: () => open,
		subscribe: (callback) => subscribers.add(callback),
		set,
		open: () => set(true),
		close: () => set(false),
		toggle: () => set(!open)
	};
};
//#endregion
export { createToggleStore };

//# sourceMappingURL=toggleStore.js.map