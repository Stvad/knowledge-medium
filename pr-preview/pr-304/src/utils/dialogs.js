import { CallbackSet } from "./callbackSet.js";
//#region src/utils/dialogs.ts
var nextId = 0;
var subscribers = new CallbackSet("dialogs");
var queue = [];
var openDialog = (Component, props) => new Promise((resolve) => {
	const id = ++nextId;
	const finalize = (value) => {
		queue = queue.filter((entry) => entry.id !== id);
		resolve(value);
		subscribers.notify();
	};
	const entry = {
		id,
		Component,
		props: props ?? {},
		finalize
	};
	queue = [...queue, entry];
	subscribers.notify();
});
var getDialogQueue = () => queue;
var subscribeDialogs = (callback) => subscribers.add(callback);
/** Test-only reset. Drops all queued dialogs (resolving each with
*  `null` so any awaiters unblock) and notifies subscribers so the
*  host unmounts. */
var __resetDialogsForTests = () => {
	const drained = queue;
	queue = [];
	nextId = 0;
	for (const entry of drained) entry.finalize(null);
	subscribers.notify();
};
//#endregion
export { __resetDialogsForTests, getDialogQueue, openDialog, subscribeDialogs };

//# sourceMappingURL=dialogs.js.map