import { supabase } from "../../services/supabase.js";
import { showError } from "../../utils/toast.js";
import { getActiveUserId, isRemoteSyncActive, syncResolverForUser } from "../../data/repoProvider.js";
import { createSupabaseBlobStore } from "./blobStore.js";
import { getByteStore } from "./byteStore.js";
import { remoteSyncGated } from "./assetResolver.js";
import { resolveCaptureMime } from "./mediaBlock.js";
import { withLock } from "./laneLock.js";
import { refreshUploadLaneStatus } from "./uploadLaneStatus.js";
import { captureMedia } from "./mediaCapture.js";
import { drainUploads } from "./uploadDrain.js";
import { recoverFailedUploads } from "./uploadRecovery.js";
import { reconcileUploads } from "./uploadReconcile.js";
import { getByteUploadStore } from "./uploadStore.js";
//#region src/plugins/attachments/assetUpload.ts
/**
* The app-wired up-lane (design §9/§11) — the single place that assembles the
* pure capture / drain / reconcile pieces with the real app deps and runs the
* background lane SINGLE-OWNER across tabs.
*
*   - capture  — {@link captureMediaFromFiles}: the renderer's paste entry (the
*     File-list plumbing is drop-ready, but only paste is wired today).
*   - drain    — {@link armUploadDrain}: fire-and-forget after a capture.
*   - reconcile — {@link runUploadReconcile}: at app start, AFTER PowerSync settles.
*
* The byte store, upload queue, and Supabase blob store are process singletons so
* capture (write), the resolver (read), the drain, and the reconciler all share
* one view. The mode/key deps are re-read from the ACTIVE user's §6 resolver per
* call so an account switch is reflected without rebuilding anything.
*
* SINGLE-OWNER: the drain + reconcile run inside a per-user `navigator.locks`
* lock, so with N tabs open exactly one runs the lane at a time (the upload is
* idempotent anyway, but this avoids N× egress). Capture stays per-tab.
*/
var blobStoreSingleton = null;
/** The app's Supabase-backed blob store, or null when there's nothing to upload to.
*  Gated on the RUNTIME remote-sync state, NOT just `supabase != null`: a local-only
*  session (the user opted out of remote at login, or toggled local-only) keeps a
*  configured Supabase client but must upload NOTHING — capture stays in OPFS and the
*  lane is a no-op (Codex P1). Re-checked each call (before the singleton) so the gate
*  is dynamic across an account/mode switch. */
var getBlobStore = () => {
	if (!supabase || !isRemoteSyncActive()) return null;
	if (!blobStoreSingleton) {
		const client = supabase;
		blobStoreSingleton = createSupabaseBlobStore({
			client,
			getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null
		});
	}
	return remoteSyncGated(blobStoreSingleton);
};
/** The §6 encode/key accessors bound to ONE user's resolver. The up-lane snapshots
*  this at its entry boundary (capture / drain), so an account switch mid-operation
*  can't make it read a DIFFERENT user's keys — "bind the lane to the user it was
*  armed for" in one place, instead of scattered `getActiveSyncResolver()` reads. A
*  null resolver (signed out) fails closed (defer / no key). */
var laneKeyDeps = (resolver) => ({
	getMaterializability: (ws) => resolver?.getMaterializability(ws) ?? "defer",
	getCek: (ws) => resolver?.getCek(ws) ?? Promise.resolve(null),
	getContentKeyHmac: (ws) => resolver?.getContentKeyHmac(ws) ?? Promise.resolve(null)
});
var drainDepsFor = (blobStore, resolver) => ({
	store: getByteUploadStore(),
	byteStore: getByteStore(),
	blobStore,
	...laneKeyDeps(resolver)
});
var laneLockName = (userId) => `km-asset-upload-lane:${userId}`;
/** Fire-and-forget drain of the active user's pending uploads (after a capture).
*  Single-owner (lane lock); a no-op when Supabase isn't configured. */
var armUploadDrain = (userId) => {
	const blobStore = getBlobStore();
	if (!blobStore) return;
	const resolver = syncResolverForUser(userId);
	withLock(laneLockName(userId), async () => {
		await drainUploads(userId, {
			...drainDepsFor(blobStore, resolver),
			isActiveUser: () => getActiveUserId() === userId
		});
		await refreshUploadLaneStatus(getByteUploadStore(), userId);
	}).catch((err) => console.warn("[assetUpload] drain failed", err));
};
/** Boot recovery: promote `staged` records whose block has materialized (a crash
*  between commit and the in-session promote), then drain. A `staged` record whose
*  block isn't in `blocks` yet is LEFT for a later boot — never reaped (§16 GC owns
*  orphan-byte reclamation; see {@link reconcileUploads}). Needs no lock: the
*  promote is idempotent, so racing an in-flight capture's stage→promote converges. */
var runUploadReconcile = async (userId, repo) => {
	await refreshUploadLaneStatus(getByteUploadStore(), userId);
	if (!getBlobStore()) return;
	await reconcileUploads(userId, {
		store: getByteUploadStore(),
		isBlockPresent: async (_ws, id) => await repo.load(id) != null
	});
	armUploadDrain(userId);
};
/** §9 failed-upload recovery — the explicit user "Retry" (the diagnostics warning's
*  button). Probes each `failed` record's content path and 3-ways it (requeue a freed path
*  → the drain re-uploads; clear an already-uploaded one; keep a poisoned one), then drains
*  the requeued records — ALL single-owner under ONE lane-lock acquisition, so recovery +
*  its drain are a single critical section (never a re-entrant lock request, which would
*  deadlock). A no-op when Supabase isn't configured / the session is local-only (nothing
*  to probe). Bound to `userId` (not the active account) end-to-end, like the drain, so an
*  account switch mid-recovery can't act under the wrong session/keys. Returns the lane
*  promise so the Retry action can debounce overlapping clicks. Queues behind an in-flight
*  lane (does NOT skip): the user asked, so this pass must actually run. */
var runUploadRecovery = (userId) => {
	const blobStore = getBlobStore();
	if (!blobStore) return Promise.resolve();
	const resolver = syncResolverForUser(userId);
	const isActiveUser = () => getActiveUserId() === userId;
	return withLock(laneLockName(userId), async () => {
		await recoverFailedUploads(userId, {
			store: getByteUploadStore(),
			blobStore,
			...laneKeyDeps(resolver),
			isActiveUser
		});
		await drainUploads(userId, {
			...drainDepsFor(blobStore, resolver),
			isActiveUser
		});
		await refreshUploadLaneStatus(getByteUploadStore(), userId);
	}).then(() => {}).catch((err) => console.warn("[assetUpload] recovery failed", err));
};
var captureDepsFor = (repo, ctx) => ({
	repo,
	byteStore: getByteStore(),
	uploadStore: getByteUploadStore(),
	getUserId: () => ctx.userId,
	...laneKeyDeps(ctx.resolver),
	drain: armUploadDrain
});
/** Read each File's bytes and capture them as content-addressed media blocks (under
*  the workspace ASSETS container). Returns one result per file — the caller builds +
*  places the `((assetBlockId))` references. Needs no lock: every queue op is idempotent
*  and the reconciler only promotes, so a concurrent capture/reconcile converges.
*
*  Files are read + captured ONE AT A TIME (bounded memory), and a grossly-oversize
*  file is rejected by its declared `size` BEFORE `arrayBuffer()` — a multi-GB paste
*  must not allocate its full size (× every file, the old `Promise.all`) just to be
*  rejected by the post-read byteLength guard. `captureMedia` still applies the
*  precise, mode-aware limit (the e2ee envelope overhead) on the bytes it reads. */
var captureMediaFromFiles = async (repo, workspaceId, files) => {
	const userId = getActiveUserId();
	if (!userId) return files.map(() => ({
		ok: false,
		reason: "no-user"
	}));
	const deps = captureDepsFor(repo, {
		userId,
		resolver: syncResolverForUser(userId)
	});
	const results = [];
	for (const file of files) {
		if (file.size > 52428800) {
			results.push({
				ok: false,
				reason: "too-large"
			});
			continue;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		const source = {
			bytes,
			mime: resolveCaptureMime(file.type, bytes),
			filename: file.name || void 0
		};
		results.push(await captureMedia({
			workspaceId,
			source
		}, deps));
	}
	return results;
};
/** User-facing message per capture failure. `captureMediaFromFiles` returns failures
*  as RESOLVED `{ok:false}` values (not throws), so without this a paste that's
*  rejected (oversize, locked workspace, …) does nothing visible — the user believes
*  it worked. */
var CAPTURE_FAILURE_MESSAGE = {
	"no-user": "Sign in to attach media.",
	empty: "That file is empty — nothing to attach.",
	"too-large": "That file is too large to attach.",
	"unsupported-mime": "That file type can’t be attached.",
	"workspace-locked": "Unlock this workspace to attach media.",
	"no-content-key": "Re-paste your workspace key to attach media."
};
/** Toast the distinct failure reasons from a (possibly multi-file) capture. Call on
*  the resolved results of {@link captureMediaFromFiles} so a silently-rejected paste
*  becomes visible feedback. De-dupes identical reasons across files. */
var reportCaptureFailures = (results) => {
	const reasons = new Set(results.flatMap((r) => r.ok ? [] : [r.reason]));
	for (const reason of reasons) showError(CAPTURE_FAILURE_MESSAGE[reason]);
};
//#endregion
export { armUploadDrain, captureMediaFromFiles, reportCaptureFailures, runUploadReconcile, runUploadRecovery };

//# sourceMappingURL=assetUpload.js.map