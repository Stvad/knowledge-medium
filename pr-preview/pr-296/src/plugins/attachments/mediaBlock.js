import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
//#region src/plugins/attachments/mediaBlock.ts
/**
* The `media` block type + its property schemas (design §3 / §11).
*
* An attachment IS a block (§3): a `media`-typed block holds the metadata for one
* content-addressed object, and is embedded everywhere via `!((id))`. The bytes
* live out-of-band in Storage (§10) + the local OPFS byte store (§8); this block
* carries only the small metadata the resolver (§7.3) and renderer (§11) need.
*
* `media:hash` is THE load-bearing field — it is the `sha256:<hex>` content hash
* (§5.1) the resolver verifies fetched bytes against and derives the object path
* from (§10). `mime` drives the renderer's branch; `size`/`filename` are
* cosmetic. (Capture — Phase 5 — populates them; this phase only defines + renders.)
*/
var MEDIA_TYPE = "media";
/** The `sha256:<hex>` content hash (§5.1). The resolver verifies fetched bytes
*  against it and derives the §10 object path from it — render-critical, never
*  cosmetic. Empty default = "no hash yet" → the renderer fails closed. */
var mediaHashProp = defineProperty("media:hash", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** The object's MIME type — drives the renderer branch (image / file). Defaults
*  to the bytes' on-the-wire type; the real value is set at capture (§11). */
var mediaMimeProp = defineProperty("media:mime", {
	codec: codecs.string,
	defaultValue: "application/octet-stream",
	changeScope: ChangeScope.BlockDefault
});
/** Plaintext byte length (cosmetic — for the file chip / pending UI). */
var mediaSizeProp = defineProperty("media:size", {
	codec: codecs.number,
	defaultValue: 0,
	changeScope: ChangeScope.BlockDefault
});
/** Original filename, when captured from a file (cosmetic; cross-device LWW). */
var mediaFilenameProp = defineProperty("media:filename", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var MEDIA_PROPERTY_SCHEMAS = [
	mediaHashProp,
	mediaMimeProp,
	mediaSizeProp,
	mediaFilenameProp
];
var MEDIA_TYPE_CONTRIBUTION = defineBlockType({
	id: MEDIA_TYPE,
	label: "Media",
	description: "An image or file attachment, stored content-addressed and embedded via !((id)).",
	properties: [...MEDIA_PROPERTY_SCHEMAS]
});
/** Does a MIME type render as an inline image (§11 image branch)? Case-insensitive
*  — MIME types are case-insensitive (RFC 2045) even though `File.type` is lowercase. */
var isImageMime = (mime) => typeof mime === "string" && mime.toLowerCase().startsWith("image/");
/** Does a MIME type render through the inline `<audio>` player (§11 audio branch)?
*  Case-insensitive, like {@link isImageMime}. */
var isAudioMime = (mime) => typeof mime === "string" && mime.toLowerCase().startsWith("audio/");
/** The PDF MIME — its inline-preview viewer (§11 PDF branch). */
var PDF_MIME = "application/pdf";
/** Does a MIME type render through the inline PDF preview (§11 PDF branch)?
*  Case-insensitive per RFC 2045; an EXACT match — `application/pdf` has no sub-family the
*  way `image/*` / `audio/*` do, and the exactness is load-bearing for the viewer's XSS
*  posture (the object URL's Blob is typed this same mime, so pinning it to `application/pdf`
*  keeps a browser from HTML-sniffing hash-verified-but-non-PDF bytes — see {@link PdfViewer}). */
var isPdfMime = (mime) => typeof mime === "string" && mime.toLowerCase() === "application/pdf";
/** The fallback MIME for a file with no declared type. */
var GENERIC_MIME = "application/octet-stream";
/** Sniff a common raster image MIME from the leading magic bytes. Returns `null`
*  for anything unrecognized (incl. a too-short buffer). */
var sniffImageMime = (b) => {
	if (b.length >= 4 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return "image/png";
	if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
	if (b.length >= 4 && b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56) return "image/gif";
	if (b.length >= 12 && b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) return "image/webp";
	if (b.length >= 2 && b[0] === 66 && b[1] === 77) return "image/bmp";
	return null;
};
/** The MIME to STORE for a captured file. `File.type` is unreliable — a pasted or
*  dropped image often arrives with an empty, generic (`octet-stream`), or even wrong
*  type, and because captures are content-addressed + DEDUP'd, the FIRST capture's
*  MIME sticks for every later embed of the same bytes. So the BYTES are authoritative:
*  if they're a recognizable image, store that (the stored MIME is then a function of
*  the bytes, like the content key — a typeless/mislabeled image still renders inline,
*  and no re-paste can disagree with the dedup'd row). Otherwise trust a specific
*  declared type, else fall back to generic. A false-positive sniff is harmless — the
*  renderer's hash-verified `<img>` falls to the placeholder on a decode failure. */
var resolveCaptureMime = (declared, bytes) => {
	const sniffed = sniffImageMime(bytes);
	if (sniffed) return sniffed;
	const d = declared?.trim();
	return d && d.toLowerCase() !== "application/octet-stream" ? d : GENERIC_MIME;
};
var ASSETS_TYPE = "assets";
/** uuid-v5 namespace for the per-workspace assets container; its id is
*  `uuidv5(workspaceId, ASSETS_NS)` (see {@link kernelPageBlockId}). */
var ASSETS_NS = "b6e4d9a1-2f47-4c3e-9a0d-7c1e8f5b2a36";
var ASSETS_ALIAS = "Assets";
var ASSETS_TYPE_CONTRIBUTION = defineBlockType({
	id: ASSETS_TYPE,
	label: "Assets",
	description: "The workspace-level container that holds content-addressed media attachment blocks."
});
//#endregion
export { ASSETS_ALIAS, ASSETS_NS, ASSETS_TYPE, ASSETS_TYPE_CONTRIBUTION, GENERIC_MIME, MEDIA_PROPERTY_SCHEMAS, MEDIA_TYPE, MEDIA_TYPE_CONTRIBUTION, PDF_MIME, isAudioMime, isImageMime, isPdfMime, mediaFilenameProp, mediaHashProp, mediaMimeProp, mediaSizeProp, resolveCaptureMime, sniffImageMime };

//# sourceMappingURL=mediaBlock.js.map