//#region src/data/internals/firstSync.ts
/** Run `cb` once the initial sync has completed — immediately if it already has
*  (or there's no sync layer), otherwise on the first `hasSynced` status change.
*  Self-disposes the listener after firing; returns a disposer for early
*  teardown. NOTE: in a connected-but-never-synced session (local-only / offline)
*  the listener simply never fires — callers must not gate required work on it. */
var onFirstSync = (db, cb) => {
	if (db.currentStatus?.hasSynced || typeof db.registerListener !== "function") {
		cb();
		return () => {};
	}
	const dispose = db.registerListener({ statusChanged: (s) => {
		if (s.hasSynced) {
			dispose();
			cb();
		}
	} });
	return dispose;
};
//#endregion
export { onFirstSync };

//# sourceMappingURL=firstSync.js.map