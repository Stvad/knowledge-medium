import v4 from "../../node_modules/uuid/dist/v4.js";
//#region src/utils/clientId.ts
/**
* A stable identifier for *this browser/device installation* — a random id
* minted once and persisted in `localStorage`, so it survives reloads but is
* distinct per browser profile and per device (two Chrome profiles on one
* machine get different ids; clearing site data mints a fresh one).
*
* This is the app-level "which client am I" notion used to group per-device
* telemetry (e.g. startup-metrics records). It is deliberately NOT:
*   - PowerSync's `getClientId()` (async, ps_kv-backed sync-client identity), nor
*   - the agent-runtime bridge's ephemeral per-process id (regenerated each load).
*/
var CLIENT_ID_KEY = "km:client-id";
var cached;
/** The persistent per-installation client id. Synchronous; safe where
*  `localStorage` is absent (node/SSR/private mode) — it falls back to a
*  process-stable id so callers within one session still get a single value. */
var getClientId = () => {
	if (cached !== void 0) return cached;
	try {
		const existing = globalThis.localStorage?.getItem(CLIENT_ID_KEY);
		if (existing) return cached = existing;
		const fresh = v4();
		globalThis.localStorage?.setItem(CLIENT_ID_KEY, fresh);
		return cached = fresh;
	} catch {
		return cached ??= v4();
	}
};
/** Test helper — drop the in-process cache so the next call re-resolves. */
var resetClientIdCache = () => {
	cached = void 0;
};
//#endregion
export { getClientId, resetClientIdCache };

//# sourceMappingURL=clientId.js.map