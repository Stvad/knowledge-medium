import { CallbackSet } from "../../utils/callbackSet.js";
//#region src/plugins/attachments/uploadLaneStatus.ts
/** Global action id the failed-uploads warning points its "Retry" button at. Defined
*  here (the surface that references it) so {@link import('./retryUploadsAction.js')} can
*  import it without this module depending on the action wiring — no import cycle. */
var RETRY_UPLOADS_ACTION_ID = "attachments.retry-failed-uploads";
var failedCount = 0;
var listeners = new CallbackSet("upload-lane-status");
/** Re-read the FAILED-record count for `userId` and publish if it changed. Called by
*  the drain after each pass and by the boot reconciler. A null user (signed out)
*  clears the count. */
var refreshUploadLaneStatus = async (store, userId) => {
	const next = userId ? await store.countByStatus(userId, "failed") : 0;
	if (next === failedCount) return;
	failedCount = next;
	listeners.notify();
};
var cachedCount = -1;
var cachedSnapshot = null;
var uploadLaneDiagnosticSource = {
	id: "attachments.uploads",
	label: "Media uploads",
	subscribe: (listener) => listeners.add(listener),
	getSnapshot: () => {
		if (failedCount !== cachedCount) {
			cachedCount = failedCount;
			cachedSnapshot = failedCount > 0 ? {
				severity: "warning",
				summary: `${failedCount} media upload${failedCount === 1 ? "" : "s"} failed`,
				detail: "Captured locally but not backed up to storage — they may be unavailable on other devices.",
				actionId: RETRY_UPLOADS_ACTION_ID,
				actionLabel: "Retry",
				nudge: true
			} : null;
		}
		return cachedSnapshot;
	}
};
//#endregion
export { RETRY_UPLOADS_ACTION_ID, refreshUploadLaneStatus, uploadLaneDiagnosticSource };

//# sourceMappingURL=uploadLaneStatus.js.map