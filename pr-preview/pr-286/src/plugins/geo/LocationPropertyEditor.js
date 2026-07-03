import { aliasesProp, typesProp } from "../../data/properties.js";
import { Button } from "../../components/ui/button.js";
import { placeAddressProp } from "./properties.js";
import "./blockTypes.js";
import { resolveApiKey } from "./googlePlacesClient.js";
import { createOrFindPlaceInteractive } from "./placeNameCollision.js";
import { useRepo } from "../../context/repo.js";
import { Crosshair } from "../../../node_modules/lucide-react/dist/esm/icons/crosshair.js";
import { Map } from "../../../node_modules/lucide-react/dist/esm/icons/map.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { APIProvider, AdvancedMarker, Map as Map$1, Pin } from "../../../node_modules/@vis.gl/react-google-maps/dist/index.modern.js";
import { pickCurrentLocation } from "./pickCurrentLocation.js";
import { usePlaceSearch } from "./usePlaceSearch.js";
import { useCallback, useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/geo/LocationPropertyEditor.tsx
/** Property editor for the `location` reference.
*
*  Surfaces three actions:
*    1. Search — typeahead bundling local Places + Google Places. Pick
*       any result, route through `createOrFindPlace`, and write the
*       resolved Place id into `location`.
*    2. Drop pin — opens a small map for free-form coordinate pick;
*       creates an unnamed Place at those coords.
*    3. Clear — sets the property back to undefined.
*
*  The "Use current location" button is wired in Phase F. */
var labelFor = (block) => {
	if (!block) return null;
	const aliases = block.properties[aliasesProp.name];
	if (Array.isArray(aliases)) {
		const alias = aliases.find((v) => typeof v === "string" && !v.startsWith("place:") && !v.startsWith("geo:"));
		if (alias) return alias;
	}
	const typesRaw = block.properties[typesProp.name];
	if (!(Array.isArray(typesRaw) && typesRaw.includes("place"))) return null;
	const addr = block.properties[placeAddressProp.name];
	if (typeof addr === "string" && addr.length > 0) return addr;
	return null;
};
var addressOf = (block) => {
	if (!block) return void 0;
	const addr = block.properties[placeAddressProp.name];
	return typeof addr === "string" ? addr : void 0;
};
var LocationPropertyEditor = ({ value, onChange }) => {
	const repo = useRepo();
	const workspaceId = repo.activeWorkspaceId ?? "";
	const search = usePlaceSearch(repo);
	const [query, setQuery] = useState("");
	const [resolved, setResolved] = useState(null);
	const [dropPinOpen, setDropPinOpen] = useState(false);
	const [pickingCurrent, setPickingCurrent] = useState(false);
	const [pickingError, setPickingError] = useState(null);
	const [accuracyHint, setAccuracyHint] = useState(null);
	useEffect(() => {
		let cancelled = false;
		const hydrate = async () => {
			if (!value) {
				setResolved(null);
				return;
			}
			const block = await repo.load(value);
			if (cancelled) return;
			setResolved({
				blockId: value,
				label: labelFor(block) ?? value,
				address: addressOf(block)
			});
		};
		hydrate();
		return () => {
			cancelled = true;
		};
	}, [value, repo]);
	const onPickLocal = useCallback((result) => {
		onChange(result.id);
		setQuery("");
	}, [onChange]);
	const onPickGoogle = useCallback(async (result_0) => {
		if (!workspaceId || !search.client) return;
		const placeId = result_0.id.replace(/^google:/, "");
		try {
			const details = await search.client.getDetails(placeId, { sessionToken: search.sessionToken });
			search.rotateSession();
			const resolved_0 = await createOrFindPlaceInteractive(repo, workspaceId, {
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
			if (!resolved_0) return;
			onChange(resolved_0.block.id);
			setQuery("");
		} catch (err) {
			console.warn("[geo] place resolve failed", err);
		}
	}, [
		workspaceId,
		search,
		repo,
		onChange
	]);
	const onPick = useCallback((result_1) => {
		if (result_1.source === "local") onPickLocal(result_1);
		else onPickGoogle(result_1);
	}, [onPickLocal, onPickGoogle]);
	const onDropPin = useCallback(async (lat, lng) => {
		if (!workspaceId) return;
		const place = await createOrFindPlaceInteractive(repo, workspaceId, {
			name: "",
			lat,
			lng
		});
		if (!place) return;
		onChange(place.block.id);
		setDropPinOpen(false);
	}, [
		workspaceId,
		repo,
		onChange
	]);
	const onClear = useCallback(() => {
		onChange(void 0);
		setQuery("");
		setAccuracyHint(null);
	}, [onChange]);
	const onUseCurrentLocation = useCallback(async () => {
		if (!workspaceId || pickingCurrent) return;
		setPickingCurrent(true);
		setPickingError(null);
		try {
			const result = await pickCurrentLocation(repo, workspaceId);
			if (!result) {
				setPickingError("Could not get current location (permission denied or unavailable).");
				return;
			}
			onChange(result.block.id);
			const snapTag = result.snappedToPOI ? "POI" : "pin";
			setAccuracyHint(`±${Math.round(result.accuracyM)}m · ${snapTag}`);
		} finally {
			setPickingCurrent(false);
		}
	}, [
		workspaceId,
		pickingCurrent,
		repo,
		onChange
	]);
	if (!workspaceId) return /* @__PURE__ */ jsx("div", {
		className: "text-xs text-muted-foreground",
		children: "No workspace selected."
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "flex w-full flex-col gap-2",
		children: [
			resolved && /* @__PURE__ */ jsxs("div", {
				className: "flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "min-w-0 flex-1",
					children: [/* @__PURE__ */ jsx("div", {
						className: "truncate font-medium",
						children: resolved.label
					}), resolved.address && /* @__PURE__ */ jsx("div", {
						className: "truncate text-xs text-muted-foreground",
						children: resolved.address
					})]
				}), /* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					size: "icon",
					onClick: onClear,
					"aria-label": "Clear location",
					children: /* @__PURE__ */ jsx(X, { className: "h-3.5 w-3.5" })
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex flex-col gap-1",
				children: [
					/* @__PURE__ */ jsx("input", {
						type: "text",
						className: "w-full rounded-md border border-input bg-background px-2 py-1 text-sm",
						placeholder: resolved ? "Change location…" : "Search for a place…",
						value: query,
						onChange: (e) => {
							const next = e.target.value;
							setQuery(next);
							search.search(next);
						}
					}),
					search.results.length > 0 && /* @__PURE__ */ jsx("div", {
						className: "max-h-56 overflow-y-auto rounded-md border border-border bg-popover",
						children: search.results.map((r) => /* @__PURE__ */ jsxs("button", {
							type: "button",
							className: "flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-2 py-1.5 text-left text-sm last:border-b-0 hover:bg-muted",
							onClick: () => onPick(r),
							children: [
								/* @__PURE__ */ jsx("span", {
									className: "truncate",
									children: r.label
								}),
								r.detail && /* @__PURE__ */ jsx("span", {
									className: "truncate text-xs text-muted-foreground",
									children: r.detail
								}),
								/* @__PURE__ */ jsx("span", {
									className: "text-[10px] uppercase tracking-wide text-muted-foreground",
									children: r.source
								})
							]
						}, r.id))
					}),
					search.loading && /* @__PURE__ */ jsx("div", {
						className: "text-xs text-muted-foreground",
						children: "Searching…"
					}),
					search.error && /* @__PURE__ */ jsx("div", {
						className: "text-xs text-destructive",
						children: search.error
					})
				]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [
					/* @__PURE__ */ jsxs(Button, {
						type: "button",
						variant: "outline",
						size: "sm",
						onClick: () => setDropPinOpen((o) => !o),
						children: [/* @__PURE__ */ jsx(Map, { className: "mr-1.5 h-3.5 w-3.5" }), dropPinOpen ? "Cancel pin" : "Drop pin"]
					}),
					/* @__PURE__ */ jsxs(Button, {
						type: "button",
						variant: "outline",
						size: "sm",
						disabled: pickingCurrent,
						onClick: () => {
							onUseCurrentLocation();
						},
						children: [/* @__PURE__ */ jsx(Crosshair, { className: "mr-1.5 h-3.5 w-3.5" }), pickingCurrent ? "Locating…" : "Use current location"]
					}),
					accuracyHint && /* @__PURE__ */ jsx("span", {
						className: "text-xs text-muted-foreground",
						children: accuracyHint
					})
				]
			}),
			pickingError && /* @__PURE__ */ jsx("div", {
				className: "text-xs text-destructive",
				children: pickingError
			}),
			dropPinOpen && /* @__PURE__ */ jsx(DropPinMap, { onDrop: onDropPin })
		]
	});
};
var DROP_PIN_DEFAULT_CENTER = {
	lat: 37.7749,
	lng: -122.4194
};
var DROP_PIN_DEFAULT_ZOOM = 11;
function DropPinMap(t0) {
	const $ = c(23);
	const { onDrop } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = resolveApiKey();
		$[0] = t1;
	} else t1 = $[0];
	const apiKey = t1;
	const [pin, setPin] = useState(null);
	if (!apiKey) {
		let t2;
		if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
			t2 = /* @__PURE__ */ jsxs("div", {
				className: "rounded-md border border-dashed border-muted-foreground/40 p-3 text-xs text-muted-foreground",
				children: [
					"Map unavailable — set ",
					/* @__PURE__ */ jsx("code", { children: "VITE_GOOGLE_MAPS_API_KEY" }),
					"."
				]
			});
			$[1] = t2;
		} else t2 = $[1];
		return t2;
	}
	let t2;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = (ev) => {
			const ll = ev.detail.latLng;
			if (ll) setPin({
				lat: ll.lat,
				lng: ll.lng
			});
		};
		$[2] = t2;
	} else t2 = $[2];
	let t3;
	if ($[3] !== pin) {
		t3 = pin && /* @__PURE__ */ jsx(AdvancedMarker, {
			position: pin,
			children: /* @__PURE__ */ jsx(Pin, {})
		});
		$[3] = pin;
		$[4] = t3;
	} else t3 = $[4];
	let t4;
	if ($[5] !== t3) {
		t4 = /* @__PURE__ */ jsx("div", {
			className: "h-64 w-full overflow-hidden rounded-md border",
			children: /* @__PURE__ */ jsx(APIProvider, {
				apiKey,
				children: /* @__PURE__ */ jsx(Map$1, {
					defaultCenter: DROP_PIN_DEFAULT_CENTER,
					defaultZoom: DROP_PIN_DEFAULT_ZOOM,
					mapId: "DEMO_MAP_ID",
					gestureHandling: "cooperative",
					onClick: t2,
					children: t3
				})
			})
		});
		$[5] = t3;
		$[6] = t4;
	} else t4 = $[6];
	let t5;
	if ($[7] !== pin) {
		t5 = pin ? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : "Click on the map to drop a pin.";
		$[7] = pin;
		$[8] = t5;
	} else t5 = $[8];
	let t6;
	if ($[9] !== t5) {
		t6 = /* @__PURE__ */ jsx("span", { children: t5 });
		$[9] = t5;
		$[10] = t6;
	} else t6 = $[10];
	const t7 = !pin;
	let t8;
	if ($[11] !== onDrop || $[12] !== pin) {
		t8 = () => pin && onDrop(pin.lat, pin.lng);
		$[11] = onDrop;
		$[12] = pin;
		$[13] = t8;
	} else t8 = $[13];
	let t9;
	if ($[14] !== t7 || $[15] !== t8) {
		t9 = /* @__PURE__ */ jsx(Button, {
			type: "button",
			variant: "default",
			size: "sm",
			disabled: t7,
			onClick: t8,
			children: "Use this pin"
		});
		$[14] = t7;
		$[15] = t8;
		$[16] = t9;
	} else t9 = $[16];
	let t10;
	if ($[17] !== t6 || $[18] !== t9) {
		t10 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center justify-between gap-2 text-xs text-muted-foreground",
			children: [t6, t9]
		});
		$[17] = t6;
		$[18] = t9;
		$[19] = t10;
	} else t10 = $[19];
	let t11;
	if ($[20] !== t10 || $[21] !== t4) {
		t11 = /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col gap-1.5",
			children: [t4, t10]
		});
		$[20] = t10;
		$[21] = t4;
		$[22] = t11;
	} else t11 = $[22];
	return t11;
}
//#endregion
export { LocationPropertyEditor };

//# sourceMappingURL=LocationPropertyEditor.js.map