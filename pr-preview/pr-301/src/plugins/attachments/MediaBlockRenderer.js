import { usePropertyValue, useWorkspaceId } from "../../hooks/block.js";
import { FileText } from "../../../node_modules/lucide-react/dist/esm/icons/file-text.js";
import { ImageOff } from "../../../node_modules/lucide-react/dist/esm/icons/image-off.js";
import { LoaderCircle } from "../../../node_modules/lucide-react/dist/esm/icons/loader-circle.js";
import { DefaultBlockRenderer } from "../../components/renderer/DefaultBlockRenderer.js";
import { MarkdownImage } from "../../markdown/MarkdownImage.js";
import { getAssetResolver } from "./assetResolver.js";
import { isImageMime, mediaFilenameProp, mediaHashProp, mediaMimeProp } from "./mediaBlock.js";
import { useAssetObjectUrl } from "./useAssetObjectUrl.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/attachments/MediaBlockRenderer.tsx
/**
* The `media`-block renderer (design §11). Mirrors the video-player plugin's
* wiring: a {@link BlockRenderer} that renders blocks carrying the `media` type
* (gated on a loaded snapshot, see canRender) at a priority above the default,
* branching on the block's `media:mime`.
*
* Image branch: resolve the bytes in-thread (§7.3), wrap them as an object URL
* (useAssetObjectUrl), and feed the existing {@link MarkdownImage} lightbox. A
* fail-closed resolve (the resolver discarded unverified bytes, §5.1) renders the
* broken-asset placeholder — NEVER a raw/unverified source. Bytes that verify but
* the browser can't DECODE as an image (an untrusted `media:mime` on non-image
* bytes, or a corrupt-but-hash-matching image) fall to the SAME placeholder via the
* <img> onError, not the browser's broken-image glyph. Non-image MIMEs get a file
* chip for now (full file/PDF/AV rendering is vNext, §15) and do NOT resolve bytes —
* only the image branch fetches/decrypts.
*/
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
/** Image branch — the ONLY path that resolves/decrypts bytes (§7.3). Split into
*  its own component so a non-image block never triggers a resolve or an object
*  URL it wouldn't use. */
var MediaImage = (t0) => {
	const $ = c(14);
	const { block, hash, mime, filename } = t0;
	const workspaceId = useWorkspaceId(block, "");
	let t1;
	if ($[0] !== hash || $[1] !== mime || $[2] !== workspaceId) {
		t1 = {
			workspaceId,
			contentHash: hash,
			mime
		};
		$[0] = hash;
		$[1] = mime;
		$[2] = workspaceId;
		$[3] = t1;
	} else t1 = $[3];
	let t2;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = getAssetResolver();
		$[4] = t2;
	} else t2 = $[4];
	const [state, reportDecodeFailure] = useAssetObjectUrl(t1, t2);
	if (state.status === "ready") {
		const t3 = filename || "Attachment image";
		let t4;
		if ($[5] !== reportDecodeFailure || $[6] !== state.url) {
			t4 = () => reportDecodeFailure(state.url);
			$[5] = reportDecodeFailure;
			$[6] = state.url;
			$[7] = t4;
		} else t4 = $[7];
		let t5;
		if ($[8] !== state.url || $[9] !== t3 || $[10] !== t4) {
			t5 = /* @__PURE__ */ jsx(MarkdownImage, {
				src: state.url,
				alt: t3,
				className: "max-w-full rounded",
				onError: t4
			});
			$[8] = state.url;
			$[9] = t3;
			$[10] = t4;
			$[11] = t5;
		} else t5 = $[11];
		return t5;
	}
	if (state.status === "loading") {
		let t3;
		if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
			t3 = /* @__PURE__ */ jsx(Placeholder, {
				testid: "media-loading",
				label: "Loading image…",
				icon: /* @__PURE__ */ jsx(LoaderCircle, { className: "h-4 w-4" }),
				spin: true
			});
			$[12] = t3;
		} else t3 = $[12];
		return t3;
	}
	let t3;
	if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx(Placeholder, {
			testid: "media-broken",
			label: "Image unavailable",
			icon: /* @__PURE__ */ jsx(ImageOff, { className: "h-4 w-4" })
		});
		$[13] = t3;
	} else t3 = $[13];
	return t3;
};
var MediaContentRenderer = (t0) => {
	const $ = c(8);
	const { block } = t0;
	const [hash] = usePropertyValue(block, mediaHashProp);
	const [mime] = usePropertyValue(block, mediaMimeProp);
	const [filename] = usePropertyValue(block, mediaFilenameProp);
	if (!isImageMime(mime)) {
		let t1;
		if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
			t1 = /* @__PURE__ */ jsx(FileText, { className: "h-4 w-4 shrink-0 text-muted-foreground" });
			$[0] = t1;
		} else t1 = $[0];
		const t2 = filename || mime || "Attachment";
		let t3;
		if ($[1] !== t2) {
			t3 = /* @__PURE__ */ jsxs("div", {
				"data-testid": "media-file",
				className: "flex items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm",
				children: [t1, /* @__PURE__ */ jsx("span", {
					className: "truncate",
					children: t2
				})]
			});
			$[1] = t2;
			$[2] = t3;
		} else t3 = $[2];
		return t3;
	}
	let t1;
	if ($[3] !== block || $[4] !== filename || $[5] !== hash || $[6] !== mime) {
		t1 = /* @__PURE__ */ jsx(MediaImage, {
			block,
			hash,
			mime,
			filename
		});
		$[3] = block;
		$[4] = filename;
		$[5] = hash;
		$[6] = mime;
		$[7] = t1;
	} else t1 = $[7];
	return t1;
};
var MediaBlockRenderer = (props) => {
	const $ = c(2);
	let t0;
	if ($[0] !== props) {
		t0 = /* @__PURE__ */ jsx(DefaultBlockRenderer, {
			...props,
			ContentRenderer: MediaContentRenderer
		});
		$[0] = props;
		$[1] = t0;
	} else t0 = $[1];
	return t0;
};
MediaBlockRenderer.canRender = ({ block }) => {
	const types = block.peek()?.properties.types;
	return Array.isArray(types) && types.includes("media");
};
MediaBlockRenderer.priority = () => 5;
//#endregion
export { MediaBlockRenderer, MediaContentRenderer };

//# sourceMappingURL=MediaBlockRenderer.js.map