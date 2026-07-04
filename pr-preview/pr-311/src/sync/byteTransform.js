import { assetBytesAad } from "./crypto/aad.js";
import { requireCek } from "./transform.js";
import { openBytes, sealBytes } from "./crypto/byteAead.js";
//#region src/sync/byteTransform.ts
/**
* The BYTE sync boundary (§5 / §6) — the asset-bytes analog of transform.ts.
*
*   encodeBytes(bytes, mode, getCek, ref)  — app → object store (seal on upload)
*   decodeBytes(blob,  mode, getCek, ref)  — object store → app (open on download)
*
* One transform parameterized by mode: `none` (plaintext) is the IDENTITY
* case — bytes pass through unchanged, exactly as encodeForWire does for text —
* and `e2ee` seals/opens with the workspace key under assetBytesAad. The object
* is content-addressed and shared by every block carrying the bytes (§10), so
* the AAD binds the CONTENT HASH, not a block id (binding a block id would stop
* a co-referencing block from opening it).
*
* decodeBytes authenticates the envelope only (AAD + GCM tag). It does NOT
* verify the bytes match the content key — that is the read-side hash check
* (verifyContentHash, §5.1 / §7.3), which the resolver runs against
* block.properties.hash before caching/serving. They stay composed at the
* resolver, not folded in here, so plaintext and e2ee share one read path.
*
* Like transform.ts, this is free of DB / PowerSync / Storage coupling: it
* knows only bytes, a mode, a key lookup, and the AAD-binding ref.
*/
/** App → object store. Identity for plaintext; AES-GCM seal for E2EE. */
var encodeBytes = async (bytes, mode, getCek, ref) => {
	if (mode === "none") return bytes;
	return sealBytes(await requireCek(getCek, ref.workspaceId, "byte transform"), bytes, assetBytesAad(ref.contentHash, ref.workspaceId));
};
/** Object store → app. Identity for plaintext; AES-GCM open for E2EE.
*  Authenticates the envelope only — the caller verifies the content hash
*  (§5.1). */
var decodeBytes = async (blob, mode, getCek, ref) => {
	if (mode === "none") return blob;
	return openBytes(await requireCek(getCek, ref.workspaceId, "byte transform"), blob, assetBytesAad(ref.contentHash, ref.workspaceId));
};
//#endregion
export { decodeBytes, encodeBytes };

//# sourceMappingURL=byteTransform.js.map