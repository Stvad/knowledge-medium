import { Download } from "../../../node_modules/lucide-react/dist/esm/icons/download.js";
import { FileExclamationPoint } from "../../../node_modules/lucide-react/dist/esm/icons/file-exclamation-point.js";
import { ImageOff } from "../../../node_modules/lucide-react/dist/esm/icons/image-off.js";
import { LoaderCircle } from "../../../node_modules/lucide-react/dist/esm/icons/loader-circle.js";
import { downloadBlob } from "../../utils/downloadBlob.js";
import { MarkdownImage } from "../../markdown/MarkdownImage.js";
import { GENERIC_MIME, isImageMime } from "./mediaBlock.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/attachments/mediaViewers.tsx
/**
* The media-block viewer components + the picker over the {@link mediaViewersFacet}
* registry (design §11).
*
* The renderer resolves a block's bytes per-viewer and hands them here:
*   - EAGER (image today; inline PDF/audio later): the bytes are resolved once into a
*     verified object URL (via {@link useAssetObjectUrl}, §7.3) and the viewer renders
*     that url. Fail-closed by construction — a `ready` url wraps ONLY hash-verified
*     bytes (§5.1); a failed resolve is `error` → the broken placeholder, never an
*     unverified source.
*   - LAZY (the download fallback): the viewer resolves NOTHING on mount — it renders
*     from metadata (filename/size/mime) and fetches the verified bytes only when the
*     user clicks download, then triggers a transient octet-stream download (never a
*     navigable `blob:` URL — see {@link FileViewer}). The bytes are already on local
*     disk in the common case (the down-lane replicates every media block for offline,
*     §8), so the click is a fast local read; staying lazy avoids retaining a decrypted
*     object-URL Blob in memory for a download nobody opened.
*/
/** A muted inline chip standing in for the real content: the loading spinner and the
*  fail-closed broken/unavailable placeholder. `role="img"` + `aria-label` so a
*  placeholder is announced as the asset it replaces, not read as empty. */
var Placeholder = (t0) => {
	const $ = c(10);
	const { testid, label, icon, spin: t1 } = t0;
	const t2 = (t1 === void 0 ? false : t1) ? "animate-spin" : void 0;
	let t3;
	if ($[0] !== icon || $[1] !== t2) {
		t3 = /* @__PURE__ */ jsx("span", {
			className: t2,
			children: icon
		});
		$[0] = icon;
		$[1] = t2;
		$[2] = t3;
	} else t3 = $[2];
	let t4;
	if ($[3] !== label) {
		t4 = /* @__PURE__ */ jsx("span", { children: label });
		$[3] = label;
		$[4] = t4;
	} else t4 = $[4];
	let t5;
	if ($[5] !== label || $[6] !== t3 || $[7] !== t4 || $[8] !== testid) {
		t5 = /* @__PURE__ */ jsxs("div", {
			"data-testid": testid,
			role: "img",
			"aria-label": label,
			className: "flex items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground",
			children: [t3, t4]
		});
		$[5] = label;
		$[6] = t3;
		$[7] = t4;
		$[8] = testid;
		$[9] = t5;
	} else t5 = $[9];
	return t5;
};
/** Format a plaintext byte length for the file affordance (e.g. `1.4 MB`). Sub-KiB is
*  shown in whole bytes; larger units keep one decimal below 10, whole above. Binary
*  (1024) units to match how the capture-size cap / byte store think about size. */
var formatByteSize = (bytes) => {
	const units = [
		"B",
		"KB",
		"MB",
		"GB",
		"TB"
	];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? value : value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} ${units[unit]}`;
};
/** EAGER image viewer — the object URL feeds the existing {@link MarkdownImage} lightbox.
*  Verified bytes the browser can't decode as an image (an untrusted `media:mime` over
*  non-image bytes, or a corrupt-but-hash-matching file) fall to the SAME broken
*  placeholder via onError, not the browser's broken-image glyph. */
var ImageViewer = (t0) => {
	const $ = c(9);
	const { state, reportDecodeFailure, filename } = t0;
	if (state.status === "ready") {
		const t1 = filename || "Attachment image";
		let t2;
		if ($[0] !== reportDecodeFailure || $[1] !== state.url) {
			t2 = () => reportDecodeFailure(state.url);
			$[0] = reportDecodeFailure;
			$[1] = state.url;
			$[2] = t2;
		} else t2 = $[2];
		let t3;
		if ($[3] !== state.url || $[4] !== t1 || $[5] !== t2) {
			t3 = /* @__PURE__ */ jsx(MarkdownImage, {
				src: state.url,
				alt: t1,
				className: "max-w-full rounded",
				onError: t2
			});
			$[3] = state.url;
			$[4] = t1;
			$[5] = t2;
			$[6] = t3;
		} else t3 = $[6];
		return t3;
	}
	if (state.status === "loading") {
		let t1;
		if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
			t1 = /* @__PURE__ */ jsx(Placeholder, {
				testid: "media-loading",
				label: "Loading image…",
				icon: /* @__PURE__ */ jsx(LoaderCircle, { className: "h-4 w-4" }),
				spin: true
			});
			$[7] = t1;
		} else t1 = $[7];
		return t1;
	}
	let t1;
	if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx(Placeholder, {
			testid: "media-broken",
			label: "Image unavailable",
			icon: /* @__PURE__ */ jsx(ImageOff, { className: "h-4 w-4" })
		});
		$[8] = t1;
	} else t1 = $[8];
	return t1;
};
/** LAZY fallback viewer for any non-image (or as-yet-unhandled) mime: a download button
*  rendered from METADATA — it resolves NO bytes until clicked. On click it fetches the
*  verified bytes and hands them to {@link downloadBlob}, which saves them under the
*  original filename via a transient, immediately-revoked anchor.
*
*  Security: the download bytes are wrapped as `application/octet-stream`, NOT the
*  block's `media:mime`. `media:mime` is attacker-influenceable metadata; a persistent
*  `<a href="blob:…" download>` typed `text/html` is a same-origin XSS vector when opened
*  in a new tab (the `download` hint is bypassed, and unreliable on iOS). A neutral
*  content-type + a non-navigable transient anchor closes that off. A failed resolve is
*  fail-closed (no bytes served) and the button reverts to a retryable error state. */
var FileViewer = (t0) => {
	const $ = c(19);
	const { resolveBytes, mime, filename, size } = t0;
	const [status, setStatus] = useState("idle");
	const label = filename || mime || "Attachment";
	let t1;
	if ($[0] !== filename || $[1] !== resolveBytes) {
		t1 = () => {
			setStatus("resolving");
			resolveBytes().then((result) => {
				if (!result.ok) {
					setStatus("error");
					return;
				}
				downloadBlob(new Blob([result.bytes], { type: GENERIC_MIME }), filename || "attachment");
				setStatus("idle");
			}).catch(() => setStatus("error"));
		};
		$[0] = filename;
		$[1] = resolveBytes;
		$[2] = t1;
	} else t1 = $[2];
	const onDownload = t1;
	const t2 = status === "resolving";
	const t3 = status === "error" ? `${label} — download failed, click to retry` : `Download ${label}`;
	let t4;
	if ($[3] !== status) {
		t4 = status === "resolving" ? /* @__PURE__ */ jsx(LoaderCircle, { className: "h-4 w-4 shrink-0 animate-spin text-muted-foreground" }) : status === "error" ? /* @__PURE__ */ jsx(FileExclamationPoint, { className: "h-4 w-4 shrink-0 text-muted-foreground" }) : /* @__PURE__ */ jsx(Download, { className: "h-4 w-4 shrink-0 text-muted-foreground" });
		$[3] = status;
		$[4] = t4;
	} else t4 = $[4];
	let t5;
	if ($[5] !== label) {
		t5 = /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: label
		});
		$[5] = label;
		$[6] = t5;
	} else t5 = $[6];
	let t6;
	if ($[7] !== size) {
		t6 = size > 0 && /* @__PURE__ */ jsx("span", {
			className: "shrink-0 text-muted-foreground",
			children: formatByteSize(size)
		});
		$[7] = size;
		$[8] = t6;
	} else t6 = $[8];
	let t7;
	if ($[9] !== status) {
		t7 = status === "error" && /* @__PURE__ */ jsx("span", {
			className: "shrink-0 text-muted-foreground",
			children: "· unavailable"
		});
		$[9] = status;
		$[10] = t7;
	} else t7 = $[10];
	let t8;
	if ($[11] !== onDownload || $[12] !== t2 || $[13] !== t3 || $[14] !== t4 || $[15] !== t5 || $[16] !== t6 || $[17] !== t7) {
		t8 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			"data-testid": "media-file",
			onClick: onDownload,
			disabled: t2,
			"aria-label": t3,
			className: "inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-70",
			children: [
				t4,
				t5,
				t6,
				t7
			]
		});
		$[11] = onDownload;
		$[12] = t2;
		$[13] = t3;
		$[14] = t4;
		$[15] = t5;
		$[16] = t6;
		$[17] = t7;
		$[18] = t8;
	} else t8 = $[18];
	return t8;
};
/** The image mime-family viewer — the attachments plugin's contribution to
*  {@link mediaViewersFacet}. */
var imageMediaViewer = {
	id: "image",
	match: isImageMime,
	Component: ImageViewer,
	eager: true
};
/** The built-in floor: every attachment is at least downloadable. Returned by
*  {@link pickMediaViewer} when no registered viewer claims the mime — NOT itself a
*  facet contribution, so it can't be dropped and a page always has a working affordance
*  even if the viewer facet is empty. A plugin CAN still override it with a match-all
*  contribution (which `find` reaches first). */
var FILE_VIEWER_FALLBACK = {
	id: "file",
	match: () => true,
	Component: FileViewer,
	eager: false
};
/** Pick the viewer for `mime` from the facet-resolved list — first match (the list is
*  precedence-ordered), else the download fallback. Total: always returns a viewer, so
*  the renderer never branches on mime itself. */
var pickMediaViewer = (viewers, mime) => viewers.find((viewer) => viewer.match(mime)) ?? FILE_VIEWER_FALLBACK;
//#endregion
export { FILE_VIEWER_FALLBACK, formatByteSize, imageMediaViewer, pickMediaViewer };

//# sourceMappingURL=mediaViewers.js.map