import { CallbackSet } from "../utils/callbackSet.js";
import { LocalDatabaseCorruptError } from "../utils/localDbCorruption.js";
//#region src/data/localDbCorruptionSignal.ts
/**
* Latching signal that routes a RUNTIME local-DB corruption into the recovery
* UI.
*
* The DB-open detector (repoProvider → `toLocalDbOpenError` → the bootstrap
* ErrorBoundary) only fires when the `.db` fails to OPEN. But an already-open DB
* can hit SQLITE_CORRUPT at runtime inside the PowerSync sync worker
* ("powersync_control: internal SQLite call returned CORRUPT"), where nothing
* throws through React — so the recovery UI never appeared for that class (the
* gap seen on the 2026-07-01 iPad incident, issue #284).
*
* The runtime watcher reports the corruption here; a sentinel component
* (`LocalDbCorruptionSentinel`) subscribed via `useSyncExternalStore` throws the
* latched error during render, so the SAME bootstrap ErrorBoundary catches it
* and shows `LocalDbCorruptionFallback` — identical Export + Reset flow as the
* open-time case.
*
* Latching (first corruption wins, never cleared): SQLITE_CORRUPT does not
* un-corrupt, and the recovery UI must not flip on and off under a retrying
* sync loop. Recovery is via reload/reset, which rebuilds this module state.
*/
var current = null;
var subscribers = new CallbackSet("localDbCorruption");
/**
* Route a detected runtime corruption to the recovery UI. Idempotent — the
* first report latches; later reports (the sync loop keeps failing) are ignored.
* `userId` MUST be the corrupt DB's owner so the recovery UI can resolve the
* OPFS `.db`; an empty id would fall through to the generic error UI.
*/
var reportRuntimeLocalDbCorruption = (userId, cause) => {
	if (current) return;
	current = new LocalDatabaseCorruptError(userId, { cause });
	subscribers.notify();
};
/** `useSyncExternalStore` getSnapshot — the latched error, or null. */
var getLocalDbCorruptionSnapshot = () => current;
/** `useSyncExternalStore` subscribe. */
var subscribeLocalDbCorruption = (callback) => subscribers.add(callback);
/** Test-only: clear the latch between cases. */
var __resetLocalDbCorruptionSignalForTest = () => {
	current = null;
};
//#endregion
export { __resetLocalDbCorruptionSignalForTest, getLocalDbCorruptionSnapshot, reportRuntimeLocalDbCorruption, subscribeLocalDbCorruption };

//# sourceMappingURL=localDbCorruptionSignal.js.map