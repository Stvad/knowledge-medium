import { aliasesProp, typesProp } from "../../data/properties.js";
import { PLACE_TYPE } from "./blockTypes.js";
import { GooglePlacesError, createGooglePlacesClient, newSessionToken, resolveApiKey } from "./googlePlacesClient.js";
import { useCallback, useEffect, useRef, useState } from "react";
//#region src/plugins/geo/usePlaceSearch.ts
/** Shared place-search hook used by both the `@` autocomplete and the
*  `location` property editor. Combines local-alias scan (Place blocks
*  in the active workspace) with Google Places autocomplete, gated by
*  the API key and a minimum query length.
*
*  The hook owns a session token that rotates after each successful
*  Google `getDetails` call — keeps the billing session bounded to a
*  single picker open. */
var GOOGLE_MIN_QUERY_LEN = 2;
var LOCAL_CAP = 8;
var GOOGLE_CAP = 6;
var DEBOUNCE_MS = 250;
var aliasesOf = (block) => {
	const raw = block.properties[aliasesProp.name];
	return Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
};
var isPlace = (block) => {
	const raw = block.properties[typesProp.name];
	return Array.isArray(raw) && raw.includes("place");
};
var displayLabel = (aliases, fallback) => aliases.find((a) => !a.startsWith("place:") && !a.startsWith("geo:")) ?? fallback;
var searchLocal = async (repo, workspaceId, query) => {
	const blocks = await repo.query.byType({
		workspaceId,
		type: PLACE_TYPE
	}).load();
	const trimmed = query.trim().toLowerCase();
	const out = [];
	for (const block of blocks) {
		if (!isPlace(block)) continue;
		const aliases = aliasesOf(block);
		const label = displayLabel(aliases, block.content);
		if (trimmed.length > 0) {
			if (![
				label,
				block.content,
				...aliases
			].some((h) => h.toLowerCase().includes(trimmed))) continue;
		}
		out.push({
			id: block.id,
			source: "local",
			label,
			detail: block.content !== label ? block.content : void 0
		});
		if (out.length >= LOCAL_CAP) break;
	}
	return out;
};
var toGoogleResults = (suggestions) => suggestions.slice(0, GOOGLE_CAP).map((s) => ({
	id: `google:${s.placeId}`,
	source: "google",
	label: s.primary,
	detail: s.secondary
}));
var usePlaceSearch = (repo, options = {}) => {
	const [client] = useState(() => {
		const apiKey = resolveApiKey();
		return apiKey ? createGooglePlacesClient({ apiKey }) : null;
	});
	const [sessionToken, setSessionToken] = useState(() => newSessionToken());
	const [state, setState] = useState({
		results: [],
		loading: false,
		error: null
	});
	const debounceTimer = useRef(null);
	const latestQuery = useRef("");
	useEffect(() => () => {
		if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
	}, []);
	const run = useCallback(async (query) => {
		const workspaceId = repo.activeWorkspaceId;
		if (!workspaceId) {
			setState({
				results: [],
				loading: false,
				error: null
			});
			return;
		}
		setState((s) => ({
			...s,
			loading: true,
			error: null
		}));
		const localClient = client;
		try {
			const local = await searchLocal(repo, workspaceId, query);
			if (latestQuery.current === query) setState({
				results: local,
				loading: localClient !== null,
				error: null
			});
			if (localClient && query.trim().length >= GOOGLE_MIN_QUERY_LEN) try {
				const suggestions = await localClient.autocomplete(query, {
					sessionToken,
					bias: options.bias
				});
				if (latestQuery.current !== query) return;
				const seen = new Set(local.map((r) => r.id));
				const google = toGoogleResults(suggestions).filter((r_0) => !seen.has(r_0.id));
				setState({
					results: [...local, ...google],
					loading: false,
					error: null
				});
			} catch (err_0) {
				if (latestQuery.current !== query) return;
				setState({
					results: local,
					loading: false,
					error: err_0 instanceof GooglePlacesError ? `Google ${err_0.kind} (${err_0.status ?? "–"})` : "Google search failed"
				});
			}
			else if (latestQuery.current === query) setState({
				results: local,
				loading: false,
				error: null
			});
		} catch (err) {
			if (latestQuery.current === query) setState({
				results: [],
				loading: false,
				error: err instanceof Error ? err.message : "search failed"
			});
		}
	}, [
		repo,
		sessionToken,
		options.bias,
		client
	]);
	const search = useCallback((query_0) => {
		latestQuery.current = query_0;
		if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
		debounceTimer.current = setTimeout(() => {
			run(query_0);
		}, DEBOUNCE_MS);
	}, [run]);
	const rotateSession = useCallback(() => {
		setSessionToken(newSessionToken());
	}, []);
	return {
		...state,
		search,
		client,
		sessionToken,
		rotateSession
	};
};
//#endregion
export { usePlaceSearch };

//# sourceMappingURL=usePlaceSearch.js.map