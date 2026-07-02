//#region src/plugins/geo/currentLocation.ts
/** Browser-geolocation wrapper for the geo plugin.
*
*  Wraps `navigator.geolocation.getCurrentPosition` with three
*  improvements over the raw API:
*    - Promise-shaped instead of callback.
*    - Distinct error kinds (`'denied' | 'unavailable' | 'timeout'`)
*      via a typed `CurrentLocationError`, so callers can branch on
*      kind for the right UX message instead of pattern-matching on
*      the upstream error code enum.
*    - Optional `navigator` injection for tests — defaults to the
*      browser global. No app-side permission storage; the browser is
*      the source of truth.
*
*  We do NOT cache coords here. Phase F UX wants a fresh fix per pick
*  session (user might have moved); caching a stale fix would silently
*  pin to the wrong spot. */
var DEFAULT_TIMEOUT_MS = 1e4;
var CurrentLocationError = class extends Error {
	constructor(kind, message) {
		super(message);
		this.kind = kind;
		this.name = "CurrentLocationError";
	}
};
var kindFor = (code) => {
	if (code === 1) return "denied";
	if (code === 2) return "unavailable";
	if (code === 3) return "timeout";
	return "unavailable";
};
var getCurrentPosition = (options = {}) => {
	const geo = (options.navigator ?? (typeof navigator !== "undefined" ? navigator : void 0))?.geolocation;
	if (!geo) return Promise.reject(new CurrentLocationError("unsupported", "Geolocation is not available in this environment"));
	return new Promise((resolve, reject) => {
		geo.getCurrentPosition((pos) => resolve({
			lat: pos.coords.latitude,
			lng: pos.coords.longitude,
			accuracy: pos.coords.accuracy
		}), (err) => reject(new CurrentLocationError(kindFor(err.code), err.message || "Geolocation failed")), {
			enableHighAccuracy: true,
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		});
	});
};
//#endregion
export { CurrentLocationError, getCurrentPosition };

//# sourceMappingURL=currentLocation.js.map