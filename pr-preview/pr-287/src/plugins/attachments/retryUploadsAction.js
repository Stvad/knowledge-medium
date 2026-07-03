import { getActiveUserId } from "../../data/repoProvider.js";
import { RefreshCw } from "../../../node_modules/lucide-react/dist/esm/icons/refresh-cw.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { RETRY_UPLOADS_ACTION_ID } from "./uploadLaneStatus.js";
import { runUploadRecovery } from "./assetUpload.js";
//#region src/plugins/attachments/retryUploadsAction.ts
/**
* The §9 failed-upload retry surface: a global action the failed-uploads diagnostics
* warning ({@link import('./uploadLaneStatus.js')}) points its "Retry" button at, and
* that the command palette lists. It runs the recovery actor
* ({@link import('./uploadRecovery.js')}) over the active user's `failed` records — a cheap
* content-path probe → 3-way (re-drive a freed path / clear an already-uploaded one / keep
* a poisoned one), then a drain. This is the ONLY recovery trigger (a deliberate §9
* simplification: transient failures are auto-retried by the drain as `pending`; only the
* quarantined `failed` set is user-driven), so the user is the rate limiter — no automatic
* re-drive bound.
*
* A single in-flight guard debounces the button: without it, N rapid clicks queue N full
* passes, each re-PUTting a freed-then-still-failing body's sealed bytes. One retry runs at
* a time; clicks while it's in flight are ignored until it settles.
*
* Lives here (not core) so it only exists when the attachments plugin does, like the
* image-insert actions.
*/
var retryInFlight = null;
var retryFailedUploadsAction = {
	id: RETRY_UPLOADS_ACTION_ID,
	description: "Retry failed media uploads",
	context: ActionContextTypes.GLOBAL,
	icon: RefreshCw,
	handler: () => {
		const userId = getActiveUserId();
		if (!userId || retryInFlight) return;
		retryInFlight = runUploadRecovery(userId);
		retryInFlight.finally(() => {
			retryInFlight = null;
		});
	}
};
//#endregion
export { retryFailedUploadsAction };

//# sourceMappingURL=retryUploadsAction.js.map