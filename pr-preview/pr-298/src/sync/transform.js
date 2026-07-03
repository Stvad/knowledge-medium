import { contentAad } from "./crypto/aad.js";
import { open, seal } from "./crypto/aead.js";
//#region src/sync/transform.ts
/**
* The sync boundary (design doc §9 / §11.1).
*
* One named place where "what crosses the wire" is transformed, sitting
* between the app domain and the PowerSync CRUD edge. Two pure functions:
*
*   encodeForWire(row, mode, getCek)  — app → wire (encrypt on upload)
*   decodeFromWire(row, mode, getCek) — wire → app (decrypt on download)
*
* For a plaintext workspace both are identity, so plaintext workspaces
* stay bit-identical to today. For an E2EE workspace they seal/open the
* three content columns independently with per-column AAD (§9.1), using
* AES-256-GCM under the workspace key (§6).
*
* KEY LOOKUP IS PLUGGABLE. The seam takes `getCek(workspaceId)` rather
* than reading any global; it returns a usable `CryptoKey` handle (§5),
* never raw bytes. The simple model implements it as an IndexedDB
* CryptoKey lookup; a future passphrase hierarchy (§13) would implement
* it as an in-memory unwrapped-CEK-map read — same call site. Keeping
* this signature stable is the single most important seam for a cheap
* hierarchy upgrade later.
*
* These functions are intentionally free of any PowerSync / DB coupling:
* the observer and upload hook (Layout B, §9.2) call them, but the
* transform itself only knows columns, a mode, and a key lookup.
*/
/** The §6 encode/decode MODE for a materializability decision, or `null` when the
*  workspace can't be turned into bytes right now — `defer`, OR an unexpected value
*  from a buggy/hostile provider (NEVER fall through to plaintext). The asset
*  capture, drain, and resolver paths all key off this ONE mapping so they can't
*  diverge (a capture that stages `e2ee` while a drain encodes `none` would corrupt
*  the object). Callers that must distinguish `defer` from an unexpected value (the
*  resolver's fail-closed split) re-inspect the input on a `null`. */
var materializabilityToMode = (m) => {
	switch (m) {
		case "decrypt": return "e2ee";
		case "copy": return "none";
		default: return null;
	}
};
/** The three columns sealed independently in E2EE mode (§9.1). */
var CONTENT_COLUMNS = [
	"content",
	"properties_json",
	"references_json"
];
/** Resolve the workspace CryptoKey or throw — the shared fail-closed guard for
*  every seam that seals/opens under the WK (the text content columns here, the
*  asset bytes in byteTransform.ts). `label` names the seam in the error so a
*  thrown "no workspace key" still says which lane raised it. */
var requireCek = async (getCek, workspaceId, label = "sync transform") => {
	const key = await getCek(workspaceId);
	if (!key) throw new Error(`${label}: no workspace key available for ${workspaceId}`);
	return key;
};
/** Apply `xform` to each of the three content columns, returning a new row
*  with all other columns preserved. `xform` runs under the workspace key
*  with each column's own AAD (§9.1). Shared by encode (seal) and decode
*  (open) so the column set and AAD construction live in one place. */
var transformContentColumns = async (row, mode, getCek, xform) => {
	if (mode === "none") return row;
	const key = await requireCek(getCek, row.workspace_id);
	const transformed = {};
	for (const column of CONTENT_COLUMNS) transformed[column] = await xform(key, row[column], contentAad(row.id, row.workspace_id, column));
	return {
		...row,
		...transformed
	};
};
/** Wire → app. Identity for plaintext; per-column AES-GCM open for E2EE. */
var decodeFromWire = (row, mode, getCek) => transformContentColumns(row, mode, getCek, open);
/**
* Encrypt the content columns PRESENT in an upload payload — app → wire for the
* Layout B upload path (§9.2). Unlike {@link encodeForWire}, which takes a full
* `WireBlockColumns` row, this seals only whichever of the three content
* columns appear, so a CREATE (full row) seals all three while a content-only
* PATCH seals just `content`. Identifiers and metadata columns
* (parent_id, order_key, timestamps, …) are passed through in the clear.
*
* `id` and `workspaceId` (always present on every PATCH per the upload trigger)
* drive the per-column AAD, identical to {@link encodeForWire}'s binding, so a
* row sealed on upload opens cleanly when {@link decodeFromWire} processes the
* full downloaded row. Identity for plaintext.
*/
var encryptUploadColumns = async (id, workspaceId, payload, mode, getCek) => {
	if (mode === "none") return payload;
	const key = await requireCek(getCek, workspaceId);
	const out = { ...payload };
	for (const column of CONTENT_COLUMNS) {
		const value = out[column];
		if (typeof value === "string") out[column] = await seal(key, value, contentAad(id, workspaceId, column));
	}
	return out;
};
//#endregion
export { decodeFromWire, encryptUploadColumns, materializabilityToMode, requireCek };

//# sourceMappingURL=transform.js.map