import { snapshotsToChangeNotification } from "../handleStore.js";
//#region src/data/internals/syncObserver/invalidate.ts
/**
* Reflect a materialization pass's `snapshots` into the cache and notify
* handles. Updates each row's cache snapshot (`applyIfNewer` for an apply,
* `markMissing` for a removal) and, for the rows the cache accepted, emits one
* `ChangeNotification` (rowIds / parentIds / workspaceIds / plugin).
*
* Returns the notification that was dispatched, or null if every row was
* rejected by the cache gate (nothing to notify).
*/
var applySyncInvalidation = (cache, handleStore, snapshots, invalidationRules = []) => {
	const accepted = /* @__PURE__ */ new Map();
	for (const [id, snap] of snapshots) if (snap.after ? cache.applyIfNewer(snap.after, "sync") : cache.markMissing(id)) accepted.set(id, snap);
	if (accepted.size === 0) return null;
	const notification = snapshotsToChangeNotification(accepted, invalidationRules);
	handleStore.invalidate(notification);
	return notification;
};
//#endregion
export { applySyncInvalidation };

//# sourceMappingURL=invalidate.js.map