//#region src/plugins/geo/googlePlacesClient.ts
/** Thin wrapper around the Google Places API (New) for the geo plugin.
*  Exposes three operations:
*
*    - `autocomplete(input, ctx)`  — text-search suggestions for the `@`
*      and property-editor pickers.
*    - `getDetails(placeId, ctx)`  — full POI details for the user's
*      selection. Reuses the same `sessionToken` as the prior
*      autocomplete call so Google bills the pair as one unit.
*    - `searchNearby({lat, lng, radiusM}, ctx)` — distance-ranked POIs
*      near a coordinate. Drives the current-location picker (Phase F).
*
*  The client is stateless w.r.t. session tokens — callers create one
*  via `newSessionToken()` at the start of a picker session and pass it
*  through. That keeps the `@` autocomplete (one session per `@` press)
*  and the property editor (one session per editor open) independently
*  governed without coupling them through hidden client state.
*
*  Network access goes through an injected `fetch` impl (defaults to
*  the global `fetch`) so tests can mock at the module boundary without
*  monkey-patching `globalThis`. */
var PLACES_API_BASE = "https://places.googleapis.com/v1";
var AUTOCOMPLETE_FIELD_MASK = [
	"suggestions.placePrediction.placeId",
	"suggestions.placePrediction.text",
	"suggestions.placePrediction.structuredFormat"
].join(",");
var DETAILS_FIELD_MASK = [
	"id",
	"displayName",
	"formattedAddress",
	"location",
	"googleMapsUri",
	"websiteUri",
	"internationalPhoneNumber",
	"types"
].join(",");
var NEARBY_FIELD_MASK = [
	"places.id",
	"places.displayName",
	"places.formattedAddress",
	"places.location",
	"places.googleMapsUri",
	"places.types"
].join(",");
var GooglePlacesError = class extends Error {
	constructor(kind, status, message) {
		super(message);
		this.kind = kind;
		this.status = status;
		this.name = "GooglePlacesError";
	}
};
var NEARBY_RADIUS_DEFAULT = 50;
var NEARBY_RADIUS_MAX = 5e4;
var NEARBY_MAX_RESULTS = 20;
var clampRadius = (radiusM) => Math.min(NEARBY_RADIUS_MAX, Math.max(1, radiusM ?? NEARBY_RADIUS_DEFAULT));
/** Haversine distance, meters. Pure helper — exported for the
*  `searchNearby` post-process and for any future caller that wants to
*  surface accuracy bands. */
var haversineMeters = (a, b) => {
	const R = 6371008.8;
	const toRad = (d) => d * Math.PI / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const sLat = Math.sin(dLat / 2);
	const sLng = Math.sin(dLng / 2);
	const c = sLat * sLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sLng * sLng;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
};
/** Per-session token. Google requires a UUID-shaped string; the actual
*  bytes are opaque — we just use the runtime's randomUUID. */
var newSessionToken = () => {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};
var createGooglePlacesClient = (options) => {
	const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
	const headers = (fieldMask) => ({
		"Content-Type": "application/json",
		"X-Goog-Api-Key": options.apiKey,
		"X-Goog-FieldMask": fieldMask
	});
	const callJson = async (url, init) => {
		let response;
		try {
			response = await fetchImpl(url, {
				method: init.method,
				headers: headers(init.fieldMask),
				body: init.body === void 0 ? void 0 : JSON.stringify(init.body)
			});
		} catch (err) {
			throw new GooglePlacesError("network", null, err instanceof Error ? err.message : "network error");
		}
		if (!response.ok) throw new GooglePlacesError("http", response.status, `Places API ${init.method} ${url} → HTTP ${response.status}`);
		try {
			return await response.json();
		} catch {
			throw new GooglePlacesError("invalid-response", response.status, "response was not valid JSON");
		}
	};
	const toDetails = (raw) => {
		if (!raw.id || !raw.location) throw new GooglePlacesError("invalid-response", null, "Place details missing id or location");
		return {
			placeId: raw.id,
			name: raw.displayName?.text ?? raw.formattedAddress ?? raw.id,
			lat: raw.location.latitude,
			lng: raw.location.longitude,
			address: raw.formattedAddress,
			googleMapsUrl: raw.googleMapsUri,
			website: raw.websiteUri,
			phone: raw.internationalPhoneNumber,
			categories: raw.types ?? []
		};
	};
	return {
		autocomplete: async (input, ctx) => {
			if (input.trim().length === 0) return [];
			const body = {
				input,
				sessionToken: ctx.sessionToken
			};
			if (ctx.bias) body.locationBias = { circle: {
				center: {
					latitude: ctx.bias.lat,
					longitude: ctx.bias.lng
				},
				radius: clampRadius(ctx.bias.radiusM)
			} };
			const result = await callJson(`${PLACES_API_BASE}/places:autocomplete`, {
				method: "POST",
				body,
				fieldMask: AUTOCOMPLETE_FIELD_MASK
			});
			const suggestions = [];
			for (const s of result.suggestions ?? []) {
				const p = s.placePrediction;
				if (!p?.placeId) continue;
				suggestions.push({
					placeId: p.placeId,
					primary: p.structuredFormat?.mainText?.text ?? p.text?.text ?? p.placeId,
					secondary: p.structuredFormat?.secondaryText?.text
				});
			}
			return suggestions;
		},
		getDetails: async (placeId, ctx) => {
			const url = new URL(`${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`);
			if (ctx.sessionToken) url.searchParams.set("sessionToken", ctx.sessionToken);
			return toDetails(await callJson(url.toString(), {
				method: "GET",
				fieldMask: DETAILS_FIELD_MASK
			}));
		},
		searchNearby: async (opts) => {
			const radius = clampRadius(opts.radiusM);
			const max = Math.min(NEARBY_MAX_RESULTS, Math.max(1, opts.maxResults ?? 5));
			const body = {
				locationRestriction: { circle: {
					center: {
						latitude: opts.lat,
						longitude: opts.lng
					},
					radius
				} },
				maxResultCount: max,
				rankPreference: "DISTANCE"
			};
			const result = await callJson(`${PLACES_API_BASE}/places:searchNearby`, {
				method: "POST",
				body,
				fieldMask: NEARBY_FIELD_MASK
			});
			const center = {
				lat: opts.lat,
				lng: opts.lng
			};
			const candidates = [];
			for (const raw of result.places ?? []) {
				if (!raw.id || !raw.location) continue;
				candidates.push({
					placeId: raw.id,
					primary: raw.displayName?.text ?? raw.formattedAddress ?? raw.id,
					secondary: raw.formattedAddress,
					lat: raw.location.latitude,
					lng: raw.location.longitude,
					distanceM: haversineMeters(center, {
						lat: raw.location.latitude,
						lng: raw.location.longitude
					}),
					googleMapsUrl: raw.googleMapsUri,
					categories: raw.types ?? []
				});
			}
			candidates.sort((a, b) => a.distanceM - b.distanceM);
			return candidates;
		}
	};
};
/** Resolve the Google Maps API key from the Vite env. Returns `null`
*  when missing — callers gate the autocomplete entirely (no Google
*  results, only local Place matches) rather than throwing. */
var resolveApiKey = () => {
	return {
		"BASE_URL": "/knowledge-medium/pr-preview/pr-287/",
		"DEV": false,
		"MODE": "production",
		"PROD": true,
		"SSR": false,
		"VITE_GOOGLE_MAPS_API_KEY": "AIzaSyD0iQzeywPHMVZTf9SyMkqi7SGnRYM7f8s",
		"VITE_POWERSYNC_URL": "https://69f28626fe1b03b656a3b6b3.powersync.journeyapps.com",
		"VITE_SUPABASE_ANON_KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsZ3lheHdjcnpvYXprYXBucXFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0NDgxMzMsImV4cCI6MjA5NDAyNDEzM30.u8OWy2477Ghk8FrXdXYfNzefAzg6ZVAPEa4rOMzct08",
		"VITE_SUPABASE_URL": "https://plgyaxwcrzoazkapnqqo.supabase.co"
	}.VITE_GOOGLE_MAPS_API_KEY ?? null;
};
//#endregion
export { GooglePlacesError, createGooglePlacesClient, haversineMeters, newSessionToken, resolveApiKey };

//# sourceMappingURL=googlePlacesClient.js.map