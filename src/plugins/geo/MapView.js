import { resolveApiKey } from "./googlePlacesClient.js";
import { PLACES_UNDER_BLOCK_QUERY } from "./query.js";
import { useRepo } from "../../context/repo.js";
import { useHandle } from "../../hooks/block.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { APIProvider, AdvancedMarker, InfoWindow, Map, Pin, useAdvancedMarkerRef } from "../../../node_modules/@vis.gl/react-google-maps/dist/index.modern.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/geo/MapView.tsx
/** Map view component — renders pins for blocks under a root.
*
*  Single component, used both inline (over any block subtree, e.g. a
*  Place page's own mini-map) and globally (rooted at the Locations
*  page). The `placesUnderBlock` query handles both shapes uniformly —
*  Place blocks pin at their own coords, non-Place blocks with
*  `location` pin at the referenced Place's coords.
*
*  Click a marker → opens an InfoWindow with the place name, address,
*  and an "Open" button that navigates to the source block. This
*  preview-on-click pattern lets the user scan a busy map without
*  losing the map context.
*
*  Renders a graceful placeholder when the Google Maps API key is
*  missing — the picker UX in Phases C / E still works, the map just
*  doesn't render. */
var DEFAULT_CENTER = {
	lat: 37.7749,
	lng: -122.4194
};
var DEFAULT_ZOOM = 11;
var MAP_ID = "DEMO_MAP_ID";
var center = (pins) => {
	if (pins.length === 0) return DEFAULT_CENTER;
	let sumLat = 0;
	let sumLng = 0;
	for (const p of pins) {
		sumLat += p.lat;
		sumLng += p.lng;
	}
	return {
		lat: sumLat / pins.length,
		lng: sumLng / pins.length
	};
};
var pinKey = (pin) => `${pin.blockId}-${pin.placeId}`;
function MapMarker(t0) {
	const $ = c(21);
	const { pin, isOpen, onSelect, onClose, onOpen } = t0;
	const [markerRef, marker] = useAdvancedMarkerRef();
	let t1;
	if ($[0] !== pin.lat || $[1] !== pin.lng) {
		t1 = {
			lat: pin.lat,
			lng: pin.lng
		};
		$[0] = pin.lat;
		$[1] = pin.lng;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] !== onSelect || $[4] !== pin) {
		t2 = () => onSelect(pin);
		$[3] = onSelect;
		$[4] = pin;
		$[5] = t2;
	} else t2 = $[5];
	let t3;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx(Pin, {});
		$[6] = t3;
	} else t3 = $[6];
	let t4;
	if ($[7] !== markerRef || $[8] !== pin.name || $[9] !== t1 || $[10] !== t2) {
		t4 = /* @__PURE__ */ jsx(AdvancedMarker, {
			ref: markerRef,
			position: t1,
			title: pin.name,
			onClick: t2,
			children: t3
		});
		$[7] = markerRef;
		$[8] = pin.name;
		$[9] = t1;
		$[10] = t2;
		$[11] = t4;
	} else t4 = $[11];
	let t5;
	if ($[12] !== isOpen || $[13] !== marker || $[14] !== onClose || $[15] !== onOpen || $[16] !== pin) {
		t5 = isOpen && marker && /* @__PURE__ */ jsx(InfoWindow, {
			anchor: marker,
			onCloseClick: onClose,
			headerContent: /* @__PURE__ */ jsx("span", {
				className: "text-sm font-medium",
				children: pin.name
			}),
			children: /* @__PURE__ */ jsxs("div", {
				className: "flex flex-col gap-2 py-1 text-sm",
				children: [pin.address && /* @__PURE__ */ jsx("p", {
					className: "text-muted-foreground",
					children: pin.address
				}), /* @__PURE__ */ jsx("button", {
					type: "button",
					className: "self-start rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted",
					onClick: (event) => onOpen(event, pin),
					children: "Open"
				})]
			})
		});
		$[12] = isOpen;
		$[13] = marker;
		$[14] = onClose;
		$[15] = onOpen;
		$[16] = pin;
		$[17] = t5;
	} else t5 = $[17];
	let t6;
	if ($[18] !== t4 || $[19] !== t5) {
		t6 = /* @__PURE__ */ jsxs(Fragment$1, { children: [t4, t5] });
		$[18] = t4;
		$[19] = t5;
		$[20] = t6;
	} else t6 = $[20];
	return t6;
}
var EMPTY_PINS = Object.freeze([]);
function MapBody(t0) {
	const $ = c(20);
	const { rootBlockId, className, defaultZoom } = t0;
	const repo = useRepo();
	const openBlock = useBlockOpener();
	let t1;
	if ($[0] !== repo.query || $[1] !== rootBlockId) {
		t1 = repo.query[PLACES_UNDER_BLOCK_QUERY]({ rootBlockId });
		$[0] = repo.query;
		$[1] = rootBlockId;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = { selector: _temp };
		$[3] = t2;
	} else t2 = $[3];
	const pins = useHandle(t1, t2);
	let t3;
	if ($[4] !== pins) {
		t3 = center(pins);
		$[4] = pins;
		$[5] = t3;
	} else t3 = $[5];
	const initialCenter = t3;
	const [openPinId, setOpenPinId] = useState(null);
	const t4 = className ?? "h-96 w-full overflow-hidden rounded-md border";
	const t5 = defaultZoom ?? DEFAULT_ZOOM;
	let t6;
	if ($[6] !== openBlock || $[7] !== openPinId || $[8] !== pins) {
		let t7;
		if ($[10] !== openBlock || $[11] !== openPinId) {
			t7 = (pin) => {
				const key = pinKey(pin);
				return /* @__PURE__ */ jsx(MapMarker, {
					pin,
					isOpen: openPinId === key,
					onSelect: (p) => setOpenPinId(pinKey(p)),
					onClose: () => setOpenPinId(null),
					onOpen: (event, p_0) => {
						setOpenPinId(null);
						openBlock(event, { blockId: p_0.blockId });
					}
				}, key);
			};
			$[10] = openBlock;
			$[11] = openPinId;
			$[12] = t7;
		} else t7 = $[12];
		t6 = pins.map(t7);
		$[6] = openBlock;
		$[7] = openPinId;
		$[8] = pins;
		$[9] = t6;
	} else t6 = $[9];
	let t7;
	if ($[13] !== initialCenter || $[14] !== t5 || $[15] !== t6) {
		t7 = /* @__PURE__ */ jsx(Map, {
			defaultCenter: initialCenter,
			defaultZoom: t5,
			mapId: MAP_ID,
			gestureHandling: "cooperative",
			children: t6
		});
		$[13] = initialCenter;
		$[14] = t5;
		$[15] = t6;
		$[16] = t7;
	} else t7 = $[16];
	let t8;
	if ($[17] !== t4 || $[18] !== t7) {
		t8 = /* @__PURE__ */ jsx("div", {
			className: t4,
			children: t7
		});
		$[17] = t4;
		$[18] = t7;
		$[19] = t8;
	} else t8 = $[19];
	return t8;
}
function _temp(data) {
	return data ?? EMPTY_PINS;
}
function MapView(props) {
	const $ = c(4);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = resolveApiKey();
		$[0] = t0;
	} else t0 = $[0];
	const apiKey = t0;
	if (!apiKey) {
		let t1;
		if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
			t1 = /* @__PURE__ */ jsxs("div", {
				className: "rounded-md border border-dashed border-muted-foreground/40 p-4 text-sm text-muted-foreground",
				children: [
					"Map disabled — set ",
					/* @__PURE__ */ jsx("code", { children: "VITE_GOOGLE_MAPS_API_KEY" }),
					" to enable."
				]
			});
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	}
	let t1;
	if ($[2] !== props) {
		t1 = /* @__PURE__ */ jsx(APIProvider, {
			apiKey,
			children: /* @__PURE__ */ jsx(MapBody, { ...props })
		});
		$[2] = props;
		$[3] = t1;
	} else t1 = $[3];
	return t1;
}
MapView.displayName = "MapView";
//#endregion
export { MapView };

//# sourceMappingURL=MapView.js.map