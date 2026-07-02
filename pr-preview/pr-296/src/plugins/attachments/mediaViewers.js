import { Download } from "../../../node_modules/lucide-react/dist/esm/icons/download.js";
import { FileExclamationPoint } from "../../../node_modules/lucide-react/dist/esm/icons/file-exclamation-point.js";
import { FileText } from "../../../node_modules/lucide-react/dist/esm/icons/file-text.js";
import { ImageOff } from "../../../node_modules/lucide-react/dist/esm/icons/image-off.js";
import { LoaderCircle } from "../../../node_modules/lucide-react/dist/esm/icons/loader-circle.js";
import { Play } from "../../../node_modules/lucide-react/dist/esm/icons/play.js";
import { VolumeX } from "../../../node_modules/lucide-react/dist/esm/icons/volume-x.js";
import { downloadBlob } from "../../utils/downloadBlob.js";
import { MarkdownImage } from "../../markdown/MarkdownImage.js";
import { GENERIC_MIME, PDF_MIME, isAudioMime, isImageMime, isPdfMime } from "./mediaBlock.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/attachments/mediaViewers.tsx
/**
* The media-block viewer components + the picker over the {@link mediaViewersFacet}
* registry (design §11).
*
* The renderer resolves a block's bytes per-viewer and hands them here:
*   - EAGER (image): the bytes are resolved once on mount into a verified object URL (via
*     {@link useAssetObjectUrl}, §7.3) and the viewer renders that url. Fail-closed by
*     construction — a `ready` url wraps ONLY hash-verified bytes (§5.1); a failed resolve
*     is `error` → the broken placeholder, never an unverified source.
*   - LAZY-INLINE (audio {@link AudioViewer}; PDF {@link PdfViewer}): renders a metadata
*     poster and resolves NOTHING on mount; on the first play/preview intent it arms the SAME
*     object-URL resolve via `requestResolve` and then renders a native `<audio>` / a bounded
*     `<object>` PDF preview at the verified url — same fail-closed guarantee, but the
*     (possibly large) bytes aren't fetched until wanted.
*   - LAZY (the download fallback): the viewer resolves NOTHING on mount — it renders
*     from metadata (filename/size/mime) and fetches the verified bytes only when the
*     user clicks download, then triggers a transient octet-stream download (never a
*     navigable `blob:` URL — see {@link useMediaDownload}). The bytes are already on local
*     disk in the common case (the down-lane replicates every media block for offline,
*     §8), so the click is a fast local read; staying lazy avoids retaining a decrypted
*     object-URL Blob in memory for media nobody opened.
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
/** The download-on-click action shared by the file fallback and the audio player's download
*  affordance. On invoke it fetches the block's VERIFIED bytes on demand (fail-closed — a
*  failed resolve serves NOTHING and settles to a retryable `error`), then hands them to
*  {@link downloadBlob}, which saves them under the original filename via a transient,
*  immediately-revoked anchor.
*
*  Security: the download bytes are wrapped as `application/octet-stream`, NOT the block's
*  `media:mime`. `media:mime` is attacker-influenceable metadata; a persistent
*  `<a href="blob:…" download>` typed `text/html` is a same-origin XSS vector when opened in
*  a new tab (the `download` hint is bypassed, and unreliable on iOS). A neutral content-type
*  + a non-navigable transient anchor closes that off. */
var useMediaDownload = (resolveBytes, filename) => {
	const $ = c(6);
	const [status, setStatus] = useState("idle");
	let t0;
	if ($[0] !== filename || $[1] !== resolveBytes) {
		t0 = () => {
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
		$[2] = t0;
	} else t0 = $[2];
	const download = t0;
	let t1;
	if ($[3] !== download || $[4] !== status) {
		t1 = {
			status,
			download
		};
		$[3] = download;
		$[4] = status;
		$[5] = t1;
	} else t1 = $[5];
	return t1;
};
/** LAZY fallback viewer for any non-image (or as-yet-unhandled) mime: a download button
*  rendered from METADATA — it resolves NO bytes until clicked, then downloads them via the
*  fail-closed, octet-stream {@link useMediaDownload} path (see there for the security
*  rationale). A failed resolve leaves the button in a retryable error state. */
var FileViewer = (t0) => {
	const $ = c(16);
	const { resolveBytes, mime, filename, size } = t0;
	const { status, download } = useMediaDownload(resolveBytes, filename);
	const label = filename || mime || "Attachment";
	const t1 = status === "resolving";
	const t2 = status === "error" ? `${label} — download failed, click to retry` : `Download ${label}`;
	let t3;
	if ($[0] !== status) {
		t3 = status === "resolving" ? /* @__PURE__ */ jsx(LoaderCircle, { className: "h-4 w-4 shrink-0 animate-spin text-muted-foreground" }) : status === "error" ? /* @__PURE__ */ jsx(FileExclamationPoint, { className: "h-4 w-4 shrink-0 text-muted-foreground" }) : /* @__PURE__ */ jsx(Download, { className: "h-4 w-4 shrink-0 text-muted-foreground" });
		$[0] = status;
		$[1] = t3;
	} else t3 = $[1];
	let t4;
	if ($[2] !== label) {
		t4 = /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: label
		});
		$[2] = label;
		$[3] = t4;
	} else t4 = $[3];
	let t5;
	if ($[4] !== size) {
		t5 = size > 0 && /* @__PURE__ */ jsx("span", {
			className: "shrink-0 text-muted-foreground",
			children: formatByteSize(size)
		});
		$[4] = size;
		$[5] = t5;
	} else t5 = $[5];
	let t6;
	if ($[6] !== status) {
		t6 = status === "error" && /* @__PURE__ */ jsx("span", {
			className: "shrink-0 text-muted-foreground",
			children: "· unavailable"
		});
		$[6] = status;
		$[7] = t6;
	} else t6 = $[7];
	let t7;
	if ($[8] !== download || $[9] !== t1 || $[10] !== t2 || $[11] !== t3 || $[12] !== t4 || $[13] !== t5 || $[14] !== t6) {
		t7 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			"data-testid": "media-file",
			onClick: download,
			disabled: t1,
			"aria-label": t2,
			className: "inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-70",
			children: [
				t3,
				t4,
				t5,
				t6
			]
		});
		$[8] = download;
		$[9] = t1;
		$[10] = t2;
		$[11] = t3;
		$[12] = t4;
		$[13] = t5;
		$[14] = t6;
		$[15] = t7;
	} else t7 = $[15];
	return t7;
};
/** A compact download icon-button (VERIFIED bytes → octet-stream, via {@link useMediaDownload})
*  — the secondary "save the file" affordance beside an inline viewer (audio player / PDF
*  preview). `testid` names the button per-viewer so each viewer's tests can target it. */
var DownloadIconButton = (t0) => {
	const $ = c(9);
	const { resolveBytes, filename, label, testid, className } = t0;
	const { status, download } = useMediaDownload(resolveBytes, filename);
	const t1 = status === "resolving";
	const t2 = status === "error" ? `${label} — download failed, click to retry` : `Download ${label}`;
	const t3 = `shrink-0 rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-70 ${className ?? ""}`;
	let t4;
	if ($[0] !== status) {
		t4 = status === "resolving" ? /* @__PURE__ */ jsx(LoaderCircle, { className: "h-4 w-4 animate-spin" }) : status === "error" ? /* @__PURE__ */ jsx(FileExclamationPoint, { className: "h-4 w-4" }) : /* @__PURE__ */ jsx(Download, { className: "h-4 w-4" });
		$[0] = status;
		$[1] = t4;
	} else t4 = $[1];
	let t5;
	if ($[2] !== download || $[3] !== t1 || $[4] !== t2 || $[5] !== t3 || $[6] !== t4 || $[7] !== testid) {
		t5 = /* @__PURE__ */ jsx("button", {
			type: "button",
			"data-testid": testid,
			onClick: download,
			disabled: t1,
			"aria-label": t2,
			className: t3,
			children: t4
		});
		$[2] = download;
		$[3] = t1;
		$[4] = t2;
		$[5] = t3;
		$[6] = t4;
		$[7] = testid;
		$[8] = t5;
	} else t5 = $[8];
	return t5;
};
/** LAZY-INLINE audio viewer for `audio/*` (§11). Renders from METADATA as a play affordance
*  and resolves NOTHING on mount — audio files can be large, so the object-URL resolve
*  (fetch → decrypt/passthrough → HASH-VERIFY → Blob → object URL) is deferred until the
*  first play intent, when it arms the SAME eager path via `requestResolve`. Once armed,
*  `state` transitions loading → ready|error just like the image viewer:
*   - `ready` ⇒ a native `<audio controls>` at the VERIFIED object URL (a `blob:` of the
*     decrypted-at-rest plaintext — it plays offline once the down-lane has replicated it,
*     §8; the Blob is typed the block's `audio/*` mime, which is safe to render, and revoked
*     on unmount by {@link useAssetObjectUrl}). Bytes that hash-verify but aren't decodable
*     audio (an untrusted `media:mime` over other bytes) fall to the SAME broken placeholder
*     via `onError → reportDecodeFailure`, never a dead player.
*   - `error` ⇒ fail-closed broken indicator (§5.1/§7.3), NEVER an unverified source.
*  A filename + a download affordance ({@link DownloadIconButton}, octet-stream) sit alongside
*  EVERY state (poster, player, broken) — because `audio/*` no longer falls through to the
*  file download fallback, the viewer itself must hold the "every attachment is at least
*  downloadable" floor (§11), including when playback fails or before the user ever plays. */
var AudioViewer = (t0) => {
	const $ = c(53);
	const { state, reportDecodeFailure, resolveBytes, requestResolve, armed, filename, size } = t0;
	const label = filename || "Audio attachment";
	if (!armed) {
		const t1 = `Play ${label}`;
		let t2;
		if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
			t2 = /* @__PURE__ */ jsx(Play, { className: "h-4 w-4 shrink-0 text-muted-foreground" });
			$[0] = t2;
		} else t2 = $[0];
		let t3;
		if ($[1] !== label) {
			t3 = /* @__PURE__ */ jsx("span", {
				className: "truncate",
				children: label
			});
			$[1] = label;
			$[2] = t3;
		} else t3 = $[2];
		let t4;
		if ($[3] !== size) {
			t4 = size > 0 && /* @__PURE__ */ jsx("span", {
				className: "shrink-0 text-muted-foreground",
				children: formatByteSize(size)
			});
			$[3] = size;
			$[4] = t4;
		} else t4 = $[4];
		let t5;
		if ($[5] !== requestResolve || $[6] !== t1 || $[7] !== t3 || $[8] !== t4) {
			t5 = /* @__PURE__ */ jsxs("button", {
				type: "button",
				"data-testid": "media-audio-play",
				onClick: requestResolve,
				"aria-label": t1,
				className: "inline-flex min-w-0 items-center gap-2 hover:opacity-80",
				children: [
					t2,
					t3,
					t4
				]
			});
			$[5] = requestResolve;
			$[6] = t1;
			$[7] = t3;
			$[8] = t4;
			$[9] = t5;
		} else t5 = $[9];
		let t6;
		if ($[10] !== filename || $[11] !== label || $[12] !== resolveBytes) {
			t6 = /* @__PURE__ */ jsx(DownloadIconButton, {
				resolveBytes,
				filename,
				label,
				testid: "media-audio-download",
				className: "ml-auto"
			});
			$[10] = filename;
			$[11] = label;
			$[12] = resolveBytes;
			$[13] = t6;
		} else t6 = $[13];
		let t7;
		if ($[14] !== t5 || $[15] !== t6) {
			t7 = /* @__PURE__ */ jsxs("div", {
				className: "inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-foreground",
				children: [t5, t6]
			});
			$[14] = t5;
			$[15] = t6;
			$[16] = t7;
		} else t7 = $[16];
		return t7;
	}
	if (state.status === "error") {
		let t1;
		if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
			t1 = /* @__PURE__ */ jsx(VolumeX, { className: "h-4 w-4 shrink-0" });
			$[17] = t1;
		} else t1 = $[17];
		let t2;
		if ($[18] !== label) {
			t2 = /* @__PURE__ */ jsxs("span", {
				className: "truncate",
				children: [label, " — unavailable"]
			});
			$[18] = label;
			$[19] = t2;
		} else t2 = $[19];
		let t3;
		if ($[20] !== size) {
			t3 = size > 0 && /* @__PURE__ */ jsx("span", {
				className: "shrink-0",
				children: formatByteSize(size)
			});
			$[20] = size;
			$[21] = t3;
		} else t3 = $[21];
		let t4;
		if ($[22] !== filename || $[23] !== label || $[24] !== resolveBytes) {
			t4 = /* @__PURE__ */ jsx(DownloadIconButton, {
				resolveBytes,
				filename,
				label,
				testid: "media-audio-download",
				className: "ml-auto"
			});
			$[22] = filename;
			$[23] = label;
			$[24] = resolveBytes;
			$[25] = t4;
		} else t4 = $[25];
		let t5;
		if ($[26] !== t2 || $[27] !== t3 || $[28] !== t4) {
			t5 = /* @__PURE__ */ jsxs("div", {
				"data-testid": "media-audio-broken",
				className: "inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground",
				children: [
					t1,
					t2,
					t3,
					t4
				]
			});
			$[26] = t2;
			$[27] = t3;
			$[28] = t4;
			$[29] = t5;
		} else t5 = $[29];
		return t5;
	}
	if (state.status === "loading") {
		let t1;
		if ($[30] === Symbol.for("react.memo_cache_sentinel")) {
			t1 = /* @__PURE__ */ jsx(Placeholder, {
				testid: "media-audio-loading",
				label: "Loading audio…",
				icon: /* @__PURE__ */ jsx(LoaderCircle, { className: "h-4 w-4" }),
				spin: true
			});
			$[30] = t1;
		} else t1 = $[30];
		return t1;
	}
	let t1;
	if ($[31] !== label) {
		t1 = /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: label
		});
		$[31] = label;
		$[32] = t1;
	} else t1 = $[32];
	let t2;
	if ($[33] !== size) {
		t2 = size > 0 && /* @__PURE__ */ jsx("span", {
			className: "shrink-0",
			children: formatByteSize(size)
		});
		$[33] = size;
		$[34] = t2;
	} else t2 = $[34];
	let t3;
	if ($[35] !== filename || $[36] !== label || $[37] !== resolveBytes) {
		t3 = /* @__PURE__ */ jsx(DownloadIconButton, {
			resolveBytes,
			filename,
			label,
			testid: "media-audio-download",
			className: "ml-auto"
		});
		$[35] = filename;
		$[36] = label;
		$[37] = resolveBytes;
		$[38] = t3;
	} else t3 = $[38];
	let t4;
	if ($[39] !== t1 || $[40] !== t2 || $[41] !== t3) {
		t4 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-2 text-sm text-muted-foreground",
			children: [
				t1,
				t2,
				t3
			]
		});
		$[39] = t1;
		$[40] = t2;
		$[41] = t3;
		$[42] = t4;
	} else t4 = $[42];
	let t5;
	if ($[43] !== reportDecodeFailure || $[44] !== state.url) {
		t5 = () => reportDecodeFailure(state.url);
		$[43] = reportDecodeFailure;
		$[44] = state.url;
		$[45] = t5;
	} else t5 = $[45];
	let t6;
	if ($[46] !== label || $[47] !== state.url || $[48] !== t5) {
		t6 = /* @__PURE__ */ jsx("audio", {
			controls: true,
			autoPlay: true,
			src: state.url,
			onError: t5,
			className: "w-full",
			"aria-label": label
		});
		$[46] = label;
		$[47] = state.url;
		$[48] = t5;
		$[49] = t6;
	} else t6 = $[49];
	let t7;
	if ($[50] !== t4 || $[51] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			"data-testid": "media-audio",
			className: "flex max-w-full flex-col gap-1 rounded border border-border bg-muted/40 p-2",
			children: [t4, t6]
		});
		$[50] = t4;
		$[51] = t6;
		$[52] = t7;
	} else t7 = $[52];
	return t7;
};
/** LAZY-INLINE PDF viewer for `application/pdf` (§11). Like {@link AudioViewer} it renders
*  from METADATA as a poster and resolves NOTHING on mount — PDFs can be large, and on a
*  browser that can't inline-render one (e.g. iOS Safari) an eager resolve would fetch +
*  decrypt bytes that never display. On the first "preview" intent it arms the SAME object-URL
*  resolve via `requestResolve`, then reads `state` like the eager path:
*   - `ready` ⇒ a bounded-height `<object type="application/pdf">` at the VERIFIED object URL
*     (a `blob:` of the decrypted-at-rest plaintext — works offline once the down-lane has
*     replicated it, §8; revoked on unmount by {@link useAssetObjectUrl}). Browsers that can't
*     render it inline show the `<object>` fallback pointing at the download.
*   - `error` ⇒ fail-closed broken indicator (§5.1/§7.3), NEVER an unverified source.
*  A filename + a download affordance ({@link DownloadIconButton}, octet-stream) sit alongside
*  EVERY state (poster, preview, broken) — application/pdf no longer falls through to the file
*  download fallback, so this viewer must hold the "every attachment is at least downloadable"
*  floor (§11), including before/without a preview and when inline rendering fails.
*
*  Security / XSS: the object URL's Blob is typed the block's `media:mime`, but this viewer only
*  matches `application/pdf` ({@link isPdfMime}), so the Blob's type is ALWAYS `application/pdf`
*  — never attacker-arbitrary. A `blob:` typed `application/pdf` is handed to the browser's PDF
*  viewer (a known non-`text/*` type isn't HTML-sniffed), so even hash-verified-but-non-PDF bytes
*  render as a broken PDF, never executable same-origin HTML; the native viewer sandboxes any
*  PDF-level JS itself. A `sandbox`ed iframe (no allow-same-origin) is deliberately NOT used: an
*  opaque-origin frame CAN'T load a parent-origin `blob:` URL (the preview would just fail), and
*  the type-pin already closes the vector — see design §11. The download stays neutral
*  octet-stream ({@link useMediaDownload}). */
var PdfViewer = (t0) => {
	const $ = c(43);
	const { state, resolveBytes, requestResolve, armed, filename, size } = t0;
	const label = filename || "PDF attachment";
	let t1;
	if ($[0] !== filename || $[1] !== label || $[2] !== resolveBytes) {
		t1 = /* @__PURE__ */ jsx(DownloadIconButton, {
			resolveBytes,
			filename,
			label,
			testid: "media-pdf-download",
			className: "ml-auto"
		});
		$[0] = filename;
		$[1] = label;
		$[2] = resolveBytes;
		$[3] = t1;
	} else t1 = $[3];
	const download = t1;
	if (!armed) {
		const t2 = `Preview ${label}`;
		let t3;
		if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
			t3 = /* @__PURE__ */ jsx(FileText, { className: "h-4 w-4 shrink-0 text-muted-foreground" });
			$[4] = t3;
		} else t3 = $[4];
		let t4;
		if ($[5] !== label) {
			t4 = /* @__PURE__ */ jsx("span", {
				className: "truncate",
				children: label
			});
			$[5] = label;
			$[6] = t4;
		} else t4 = $[6];
		let t5;
		if ($[7] !== size) {
			t5 = size > 0 && /* @__PURE__ */ jsx("span", {
				className: "shrink-0 text-muted-foreground",
				children: formatByteSize(size)
			});
			$[7] = size;
			$[8] = t5;
		} else t5 = $[8];
		let t6;
		if ($[9] !== requestResolve || $[10] !== t2 || $[11] !== t4 || $[12] !== t5) {
			t6 = /* @__PURE__ */ jsxs("button", {
				type: "button",
				"data-testid": "media-pdf-preview",
				onClick: requestResolve,
				"aria-label": t2,
				className: "inline-flex min-w-0 items-center gap-2 hover:opacity-80",
				children: [
					t3,
					t4,
					t5
				]
			});
			$[9] = requestResolve;
			$[10] = t2;
			$[11] = t4;
			$[12] = t5;
			$[13] = t6;
		} else t6 = $[13];
		let t7;
		if ($[14] !== download || $[15] !== t6) {
			t7 = /* @__PURE__ */ jsxs("div", {
				className: "inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-foreground",
				children: [t6, download]
			});
			$[14] = download;
			$[15] = t6;
			$[16] = t7;
		} else t7 = $[16];
		return t7;
	}
	if (state.status === "error") {
		let t2;
		if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
			t2 = /* @__PURE__ */ jsx(FileExclamationPoint, { className: "h-4 w-4 shrink-0" });
			$[17] = t2;
		} else t2 = $[17];
		let t3;
		if ($[18] !== label) {
			t3 = /* @__PURE__ */ jsxs("span", {
				className: "truncate",
				children: [label, " — unavailable"]
			});
			$[18] = label;
			$[19] = t3;
		} else t3 = $[19];
		let t4;
		if ($[20] !== size) {
			t4 = size > 0 && /* @__PURE__ */ jsx("span", {
				className: "shrink-0",
				children: formatByteSize(size)
			});
			$[20] = size;
			$[21] = t4;
		} else t4 = $[21];
		let t5;
		if ($[22] !== download || $[23] !== t3 || $[24] !== t4) {
			t5 = /* @__PURE__ */ jsxs("div", {
				"data-testid": "media-pdf-broken",
				className: "inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground",
				children: [
					t2,
					t3,
					t4,
					download
				]
			});
			$[22] = download;
			$[23] = t3;
			$[24] = t4;
			$[25] = t5;
		} else t5 = $[25];
		return t5;
	}
	if (state.status === "loading") {
		let t2;
		if ($[26] === Symbol.for("react.memo_cache_sentinel")) {
			t2 = /* @__PURE__ */ jsx(Placeholder, {
				testid: "media-pdf-loading",
				label: "Loading PDF…",
				icon: /* @__PURE__ */ jsx(LoaderCircle, { className: "h-4 w-4" }),
				spin: true
			});
			$[26] = t2;
		} else t2 = $[26];
		return t2;
	}
	let t2;
	if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx(FileText, { className: "h-4 w-4 shrink-0" });
		$[27] = t2;
	} else t2 = $[27];
	let t3;
	if ($[28] !== label) {
		t3 = /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: label
		});
		$[28] = label;
		$[29] = t3;
	} else t3 = $[29];
	let t4;
	if ($[30] !== size) {
		t4 = size > 0 && /* @__PURE__ */ jsx("span", {
			className: "shrink-0",
			children: formatByteSize(size)
		});
		$[30] = size;
		$[31] = t4;
	} else t4 = $[31];
	let t5;
	if ($[32] !== download || $[33] !== t3 || $[34] !== t4) {
		t5 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground",
			children: [
				t2,
				t3,
				t4,
				download
			]
		});
		$[32] = download;
		$[33] = t3;
		$[34] = t4;
		$[35] = t5;
	} else t5 = $[35];
	let t6;
	if ($[36] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = /* @__PURE__ */ jsx("div", {
			className: "px-3 py-8 text-center text-sm text-muted-foreground",
			children: "This browser can’t preview PDFs inline — use the download button above."
		});
		$[36] = t6;
	} else t6 = $[36];
	let t7;
	if ($[37] !== label || $[38] !== state.url) {
		t7 = /* @__PURE__ */ jsx("object", {
			data: state.url,
			type: PDF_MIME,
			"aria-label": label,
			className: "block h-[60vh] max-h-[800px] w-full bg-background",
			children: t6
		});
		$[37] = label;
		$[38] = state.url;
		$[39] = t7;
	} else t7 = $[39];
	let t8;
	if ($[40] !== t5 || $[41] !== t7) {
		t8 = /* @__PURE__ */ jsxs("div", {
			"data-testid": "media-pdf",
			className: "flex max-w-full flex-col gap-1 overflow-hidden rounded border border-border bg-muted/40",
			children: [t5, t7]
		});
		$[40] = t5;
		$[41] = t7;
		$[42] = t8;
	} else t8 = $[42];
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
/** The audio mime-family viewer. `eager: false` — the (possibly large) bytes resolve only
*  on the first play, not on mount (see {@link AudioViewer}); the renderer therefore skips
*  the mount-time resolve and the viewer arms it via `requestResolve`. */
var audioMediaViewer = {
	id: "audio",
	match: isAudioMime,
	Component: AudioViewer,
	eager: false
};
/** The inline-PDF viewer. `eager: false` — like audio, the (possibly large) bytes resolve only
*  on the first "preview" intent, not on mount (see {@link PdfViewer}); the renderer skips the
*  mount-time resolve and the viewer arms it via `requestResolve`. */
var pdfMediaViewer = {
	id: "pdf",
	match: isPdfMime,
	Component: PdfViewer,
	eager: false
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
export { FILE_VIEWER_FALLBACK, audioMediaViewer, formatByteSize, imageMediaViewer, pdfMediaViewer, pickMediaViewer };

//# sourceMappingURL=mediaViewers.js.map