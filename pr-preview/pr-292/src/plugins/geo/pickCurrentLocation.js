import { GooglePlacesError, createGooglePlacesClient, newSessionToken, resolveApiKey } from "./googlePlacesClient.js";
import { createOrFindPlaceInteractive } from "./placeNameCollision.js";
import { CurrentLocationError, getCurrentPosition } from "./currentLocation.js";
//#region src/plugins/geo/pickCurrentLocation.ts
var SNAP_RADIUS_M = 50;
var buildClient = () => {
	const key = resolveApiKey();
	return key ? createGooglePlacesClient({ apiKey: key }) : null;
};
var pickCurrentLocation = async (repo, workspaceId) => {
	let fix;
	try {
		fix = await getCurrentPosition();
	} catch (err) {
		if (err instanceof CurrentLocationError) {
			console.warn(`[geo] current location ${err.kind}: ${err.message}`);
			return null;
		}
		throw err;
	}
	const client = buildClient();
	if (client) try {
		const closest = (await client.searchNearby({
			lat: fix.lat,
			lng: fix.lng,
			radiusM: SNAP_RADIUS_M,
			maxResults: 5
		}))[0];
		if (closest && closest.distanceM <= SNAP_RADIUS_M) {
			const sessionToken = newSessionToken();
			const details = await client.getDetails(closest.placeId, { sessionToken });
			const resolved = await createOrFindPlaceInteractive(repo, workspaceId, {
				name: details.name,
				lat: details.lat,
				lng: details.lng,
				address: details.address,
				googlePlaceId: details.placeId,
				googleMapsUrl: details.googleMapsUrl,
				website: details.website,
				phone: details.phone,
				categories: details.categories
			});
			if (!resolved) return null;
			return {
				block: resolved.block,
				accuracyM: fix.accuracy,
				snappedToPOI: true
			};
		}
	} catch (err) {
		if (err instanceof GooglePlacesError) console.warn("[geo] nearby search failed; falling back to ad-hoc pin", err);
		else throw err;
	}
	const resolved = await createOrFindPlaceInteractive(repo, workspaceId, {
		name: "",
		lat: fix.lat,
		lng: fix.lng
	});
	if (!resolved) return null;
	return {
		block: resolved.block,
		accuracyM: fix.accuracy,
		snappedToPOI: false
	};
};
//#endregion
export { pickCurrentLocation };

//# sourceMappingURL=pickCurrentLocation.js.map