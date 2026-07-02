import { CallbackSet } from "./utils/callbackSet.js";
//#region src/requestPersistentStorage.ts
/**
* Ask the browser to make this origin's storage *persistent* so it's exempt
* from automatic eviction under storage pressure.
*
* Why: the app is local-first and keeps significant state in the origin's
* default storage bucket — the SQLite database (OPFS, via PowerSync /
* wa-sqlite), the per-workspace E2EE workspace-key store (IndexedDB
* `km-e2ee-keys`), and (planned) media caches. Under the WHATWG Storage
* Standard that whole bucket is "best-effort" by default: the browser may
* evict it when the device runs low on space. Losing the local SQLite DB is
* the most painful failure — it can hold unsynced edits and local-only history
* the server has never seen — so we ask for persistence.
*
* `navigator.storage.persist()` is origin-wide and all-or-nothing: it makes
* the *entire* default bucket persistent (never auto-evicted; cleared only by
* an explicit user action like clearing site data). How it resolves depends on
* the engine:
*   - **Chromium** never prompts — it grants silently from heuristics (site
*     engagement, bookmarked, installed PWA, notifications permission…). A
*     `false` here is a *silent* denial that a later call can flip to `true`
*     as engagement grows or the app is installed.
*   - **Safari (17+)** behaves like Chromium here — silent, heuristic, no
*     prompt — so it needs no special-casing.
*   - **Firefox** shows a permission prompt; an explicit "Block" is a durable
*     denial, a dismissal leaves it undecided.
*   - Engines that lack `persist()`/`persisted()` entirely (very old browsers)
*     fall out of the generic feature-detect below and no-op — again, no
*     per-engine branch.
*
* Two competing constraints follow, and we thread both:
*   1. *Don't nag.* Re-calling `persist()` every page load would re-prompt a
*      Firefox user who already saw the prompt. So we (a) treat a Permissions
*      API `'denied'` state as a permanent skip — the strongest "user said no"
*      signal (in practice Firefox-only; Chromium/Safari grant silently and
*      never report `'denied'`) — and (b) otherwise ask at most once per
*      *cooldown window*, recorded origin-wide so it's shared across tabs.
*   2. *Don't permanently gate silent denials.* A Chromium/Safari silent denial
*      reports `'prompt'` (never `'denied'`), so it never trips the permanent
*      skip; and because the cooldown marker has an expiry, a later attempt
*      retries — letting persistence be granted as engagement grows. (A
*      grant the browser makes on its own, e.g. on PWA install, is caught up
*      front by `persisted()`.)
*
* A deliberate, user-initiated retry (a future settings affordance that can
* explain *why* first) passes `{force: true}` to bypass both gates.
*
* See `docs/storage-persistence.md` for the durability model and the (not yet
* built) Storage Buckets API path for differential durability.
*
* @returns whether storage is persistent after this call (already-granted or
*   newly granted both resolve `true`).
*/
var PERSIST_ATTEMPT_KEY = "storage.persistAttemptedAt";
var RETRY_COOLDOWN_MS = 10080 * 60 * 1e3;
var attemptedWithinCooldown = () => {
	try {
		const raw = globalThis.localStorage?.getItem(PERSIST_ATTEMPT_KEY);
		if (!raw) return false;
		const at = Number(raw);
		return Number.isFinite(at) && Date.now() - at < RETRY_COOLDOWN_MS;
	} catch {
		return false;
	}
};
var markAttempted = () => {
	try {
		globalThis.localStorage?.setItem(PERSIST_ATTEMPT_KEY, String(Date.now()));
	} catch {}
};
/** The `persistent-storage` permission state, or `undefined` when the
*  Permissions API can't answer for it (older Firefox, Safari). Best-effort:
*  used only to make a durable `'denied'` a permanent skip. */
var queryPersistPermission = async () => {
	try {
		return (await navigator.permissions?.query({ name: "persistent-storage" }))?.state;
	} catch {
		return;
	}
};
var changeListeners = new CallbackSet("persistence-change");
/** Subscribe to persistence-state changes from a settled persist() request.
*  Returns an unsubscribe. */
var subscribePersistenceChange = (listener) => changeListeners.add(listener);
var notifyPersistenceChange = () => changeListeners.notify();
/** Read-only snapshot of the current persistence state, for UI that reflects
*  it (the status-chip reminder). Never throws; an unsupported engine reports
*  `{supported: false}`. Distinct from {@link requestPersistentStorage}, which
*  has the once-per-session request gating. */
var getPersistenceState = async () => {
	if (typeof navigator === "undefined") return {
		supported: false,
		persisted: false,
		permission: void 0
	};
	const storage = navigator.storage;
	if (!storage || typeof storage.persist !== "function" || typeof storage.persisted !== "function") return {
		supported: false,
		persisted: false,
		permission: void 0
	};
	let persisted;
	try {
		persisted = await storage.persisted();
	} catch {
		persisted = false;
	}
	return {
		supported: true,
		persisted,
		permission: await queryPersistPermission()
	};
};
var requestPersistentStorage = async ({ force = false } = {}) => {
	if (typeof navigator === "undefined") return false;
	const storage = navigator.storage;
	if (!storage || typeof storage.persist !== "function" || typeof storage.persisted !== "function") return false;
	try {
		if (await storage.persisted()) {
			console.info("[storage] already persistent — exempt from automatic eviction");
			return true;
		}
		if (!force) {
			if (await queryPersistPermission() === "denied") {
				console.info("[storage] persistence previously denied by the user — not re-requesting");
				return false;
			}
			if (attemptedWithinCooldown()) return false;
		}
		markAttempted();
		const granted = await storage.persist();
		if (granted) console.info("[storage] persistence granted — origin exempt from automatic eviction");
		else console.warn("[storage] persistence not granted — local data (SQLite DB, workspace keys) may be evicted under storage pressure. The browser may grant it later as site engagement grows or once the app is installed as a PWA.");
		notifyPersistenceChange();
		return granted;
	} catch (err) {
		console.warn("[storage] persistence request failed", err);
		return false;
	}
};
//#endregion
export { getPersistenceState, requestPersistentStorage, subscribePersistenceChange };

//# sourceMappingURL=requestPersistentStorage.js.map