import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { aliasesProp, typesProp } from "../../data/properties.js";
import { PLACE_TYPE } from "./blockTypes.js";
import { EditorState } from "../../../node_modules/@codemirror/state/dist/index.js";
import { EditorView } from "../../../node_modules/@codemirror/view/dist/index.js";
import { startCompletion } from "../../../node_modules/@codemirror/autocomplete/dist/index.js";
import { placeCompletionSource } from "./placeAutocomplete.js";
import { GooglePlacesError, createGooglePlacesClient, newSessionToken, resolveApiKey } from "./googlePlacesClient.js";
import { createOrFindPlaceInteractive } from "./placeNameCollision.js";
import { CurrentLocationError, getCurrentPosition } from "./currentLocation.js";
//#region src/plugins/geo/codeMirrorExtensions.ts
/** CodeMirror surface for the geo plugin: autocomplete theme + `@`
*  completion source contributed via `EditorState.languageData`. The
*  single central `autocompletion()` call (in
*  `src/editor/autocomplete.ts`) walks language data and
*  picks the source up.
*
*  Current-location flow: picking the sentinel does NOT auto-resolve —
*  it fetches geolocation + nearby POIs and re-opens the autocomplete
*  with that list plus "Drop pin at exact coords" and "Create named
*  place here…" fallbacks. The picker stage rides the same CM dropdown
*  via `startCompletion(view)` after stashing the candidates in the
*  closure. The session token, Google client, and resolver all live in
*  that closure (created per editor mount), so the billing session
*  boundary still matches "one `@` press' worth of interactions". */
var GOOGLE_MIN_QUERY_LEN = 2;
var LOCAL_RESULT_CAP = 8;
var GOOGLE_RESULT_CAP = 6;
var NEARBY_PICKER_RADIUS_M = 200;
var NEARBY_PICKER_MAX = 8;
var placeAutocompleteTheme = EditorView.theme({ ".cm-tooltip.cm-tooltip-autocomplete.tm-place-autocomplete": {
	zIndex: "1000",
	overflow: "hidden",
	border: "1px solid hsl(var(--border))",
	borderRadius: "var(--radius-md)",
	backgroundColor: "hsl(var(--popover))",
	color: "hsl(var(--popover-foreground))",
	padding: "0.25rem",
	fontFamily: "inherit",
	fontSize: "0.875rem",
	lineHeight: "1.25rem",
	boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)"
} });
var aliasesOf = (block) => {
	const raw = block.properties[aliasesProp.name];
	return Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
};
var isPlaceBlock = (block) => {
	const raw = block.properties[typesProp.name];
	return Array.isArray(raw) && raw.includes("place");
};
var buildPlaceCompletionSource = ({ repo, block }) => {
	const apiKey = resolveApiKey();
	const googleClient = apiKey ? createGooglePlacesClient({ apiKey }) : null;
	let sessionToken = newSessionToken();
	let pendingPicker = null;
	const consumePendingCandidates = () => {
		const out = pendingPicker;
		pendingPicker = null;
		return out;
	};
	const localCandidates = async (query) => {
		const workspaceId = repo.activeWorkspaceId;
		if (!workspaceId) return [];
		const placeBlocks = await repo.query.byType({
			workspaceId,
			type: PLACE_TYPE
		}).load();
		const trimmed = query.trim().toLowerCase();
		const candidates = [];
		for (const block of placeBlocks) {
			if (!isPlaceBlock(block)) continue;
			const aliases = aliasesOf(block);
			const display = aliases.find((a) => !a.startsWith("place:") && !a.startsWith("geo:")) ?? block.content;
			if (trimmed.length > 0) {
				if (![
					display,
					block.content,
					...aliases
				].some((h) => h.toLowerCase().includes(trimmed))) continue;
			}
			candidates.push({
				id: block.id,
				source: "local",
				label: display,
				detail: block.content !== display ? block.content : void 0,
				insertText: display
			});
			if (candidates.length >= LOCAL_RESULT_CAP) break;
		}
		return candidates;
	};
	const googleCandidates = async (query) => {
		if (!googleClient) return [];
		if (query.trim().length < GOOGLE_MIN_QUERY_LEN) return [];
		let suggestions;
		try {
			suggestions = await googleClient.autocomplete(query, { sessionToken });
		} catch (err) {
			if (err instanceof GooglePlacesError) {
				console.warn("[geo] Google autocomplete failed", err);
				return [];
			}
			throw err;
		}
		return suggestions.slice(0, GOOGLE_RESULT_CAP).map((s) => ({
			id: `google:${s.placeId}`,
			source: "google",
			label: s.primary,
			detail: s.secondary,
			insertText: s.primary
		}));
	};
	const currentLocationSentinel = (query) => {
		const trimmed = query.trim().toLowerCase();
		if (trimmed.length > 0 && trimmed !== "here" && trimmed !== "current") return [];
		return [{
			id: "sentinel:current-location",
			source: "sentinel:current-location",
			label: "📍 Use current location…",
			detail: "Drop a pin or snap to a nearby place",
			insertText: ""
		}];
	};
	const getCandidates = async (query) => {
		const [local, google] = await Promise.all([localCandidates(query), googleCandidates(query)]);
		const seenGoogleIds = new Set(local.map((c) => c.id).filter((id) => id.startsWith("google:")).map((id) => id.replace("google:", "")));
		return [
			...currentLocationSentinel(query),
			...local,
			...google.filter((c) => !seenGoogleIds.has(c.id.replace("google:", "")))
		];
	};
	const buildNearbyPickerCandidates = (fix, nearby) => {
		const accuracyHint = `±${Math.round(fix.accuracy)}m`;
		const nearbyOptions = nearby.map((n) => ({
			id: `google:${n.placeId}`,
			source: "google",
			label: n.primary,
			detail: [
				`${Math.round(n.distanceM)}m`,
				accuracyHint,
				n.secondary
			].filter(Boolean).join(" · "),
			insertText: n.primary
		}));
		const fallbacks = [{
			id: `drop-pin:${fix.lat},${fix.lng}`,
			source: "drop-pin",
			label: "📌 Drop pin at exact location",
			detail: `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} (${accuracyHint})`,
			insertText: "",
			coords: {
				lat: fix.lat,
				lng: fix.lng
			}
		}, {
			id: `create-named:${fix.lat},${fix.lng}`,
			source: "create-named",
			label: "✏️ Create named place here…",
			detail: `You'll be prompted for the name (${accuracyHint})`,
			insertText: "",
			coords: {
				lat: fix.lat,
				lng: fix.lng
			}
		}];
		return [...nearbyOptions, ...fallbacks];
	};
	const openCurrentLocationPicker = async (view, span) => {
		let fix;
		try {
			fix = await getCurrentPosition();
		} catch (err) {
			if (err instanceof CurrentLocationError) {
				console.warn(`[geo] current location ${err.kind}: ${err.message}`);
				return;
			}
			throw err;
		}
		let nearby = [];
		if (googleClient) try {
			nearby = await googleClient.searchNearby({
				lat: fix.lat,
				lng: fix.lng,
				radiusM: NEARBY_PICKER_RADIUS_M,
				maxResults: NEARBY_PICKER_MAX
			});
		} catch (err) {
			if (!(err instanceof GooglePlacesError)) throw err;
			console.warn("[geo] nearby search failed; showing fallbacks only", err);
		}
		pendingPicker = {
			span,
			candidates: buildNearbyPickerCandidates(fix, nearby)
		};
		startCompletion(view);
	};
	const resolvePlace = async (candidate, ctx) => {
		const workspaceId = repo.activeWorkspaceId;
		if (!workspaceId) return null;
		if (candidate.source === "local") return {
			kind: "insert",
			name: candidate.insertText
		};
		if (candidate.source === "google") {
			if (!googleClient) return null;
			const placeId = candidate.id.replace(/^google:/, "");
			try {
				const details = await googleClient.getDetails(placeId, { sessionToken });
				sessionToken = newSessionToken();
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
					kind: "insert",
					name: resolved.linkName
				};
			} catch (err) {
				console.warn("[geo] Google details / place creation failed", err);
				return null;
			}
		}
		if (candidate.source === "sentinel:current-location") {
			await openCurrentLocationPicker(ctx.view, {
				from: ctx.from,
				to: ctx.to
			});
			return { kind: "handled" };
		}
		if (candidate.source === "drop-pin") {
			if (!candidate.coords) return null;
			const resolved = await createOrFindPlaceInteractive(repo, workspaceId, {
				name: "",
				lat: candidate.coords.lat,
				lng: candidate.coords.lng
			});
			if (!resolved) return null;
			return {
				kind: "insert",
				name: resolved.linkName
			};
		}
		if (candidate.source === "create-named") {
			if (!candidate.coords) return null;
			const trimmed = (typeof window !== "undefined" ? window.prompt("Name this location:") : null)?.trim();
			if (!trimmed) return null;
			const resolved = await createOrFindPlaceInteractive(repo, workspaceId, {
				name: trimmed,
				lat: candidate.coords.lat,
				lng: candidate.coords.lng
			});
			if (!resolved) return null;
			return {
				kind: "insert",
				name: resolved.linkName
			};
		}
		return null;
	};
	const persistInsert = async ({ triggerText, insert }) => {
		await repo.tx(async (tx) => {
			const data = await tx.get(block.id);
			if (!data || data.deleted) return;
			const idx = data.content.indexOf(triggerText);
			if (idx === -1) return;
			const next = data.content.slice(0, idx) + insert + data.content.slice(idx + triggerText.length);
			await tx.update(block.id, { content: next });
		}, {
			scope: ChangeScope.BlockDefault,
			description: "insert place link"
		});
	};
	return placeCompletionSource({
		getCandidates,
		resolvePlace,
		consumePendingCandidates,
		persistInsert
	});
};
var geoCodeMirrorExtensions = (ctx) => {
	const placeSource = buildPlaceCompletionSource(ctx);
	return [placeAutocompleteTheme, EditorState.languageData.of(() => [{ autocomplete: placeSource }])];
};
//#endregion
export { geoCodeMirrorExtensions };

//# sourceMappingURL=codeMirrorExtensions.js.map