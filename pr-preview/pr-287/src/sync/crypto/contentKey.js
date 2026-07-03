import { bytesToHex } from "./hex.js";
import { digestFromContentHash } from "./contentHash.js";
//#region src/sync/crypto/contentKey.ts
/**
* The content-addressed Storage path's CONTENT KEY (§10).
*
* An object lives at `<workspace_id>/<content-key>`, where the content-key is
* derived from the PLAINTEXT bytes' sha256 digest:
*
*   plaintext workspace → content-key = hex(sha256(plaintext))        (raw)
*   E2EE workspace      → content-key = hex(HMAC(K_id, sha256(plain)))  (keyed)
*
* Content-addressing makes uploads idempotent and object dedup an invariant.
* The per-workspace HMAC subkey `K_id` is what keeps an E2EE path from becoming
* a CONTENT ORACLE: a raw `sha256(plaintext)` path would let the untrusted
* server confirm "does this workspace hold this known file?" by hashing a
* candidate and probing for the object. Keying the hash with a secret only the
* workspace's devices hold removes that — deterministic within a workspace
* (idempotent + dedup), unguessable to the server, distinct across workspaces.
*
* K_id is derived from the raw WK bytes via HKDF at WK import/unlock time (the
* only window the raw bytes are in scope — the stored WK handle is a
* non-extractable AES-GCM key WebCrypto won't sign with), and persisted as its
* OWN non-extractable HMAC `CryptoKey` co-located with the WK (§10 / keyStore).
* The `info` label domain-separates this derivation from any other WK-derived
* key, exactly as aad.ts domain-separates the canary from content columns.
*/
/** HKDF `info` label binding K_id to this purpose + version (§10). NOT optional:
*  it domain-separates the content-key subkey from any future WK-derived key
*  (the deferred key hierarchy, a per-asset share key). Versioned for a clean
*  future rotation. */
var CONTENT_KEY_HKDF_INFO = "km/asset-content-key/v1";
/** K_id length — 32 bytes (a full SHA-256 block, matches the HMAC hash). */
var CONTENT_KEY_HMAC_BITS = 256;
/**
* Derive the per-workspace content-key HMAC subkey (`K_id`, §10) from the raw
* WK bytes. `HKDF-SHA256(ikm = WK bytes, salt = "", info = the label, L = 32)`,
* imported NON-EXTRACTABLE as an HMAC/SHA-256 signing key. The empty salt is
* safe — the WK is already 32 uniform random bytes. The caller must hold the
* raw WK bytes (available only at import/unlock) and is responsible for zeroing
* them after; this function zeroes the intermediate K_id `bits` it materializes
* (the content-key oracle secret) once the non-extractable key is imported.
*/
var deriveContentKeyHmac = async (wkBytes) => {
	const ikm = await crypto.subtle.importKey("raw", wkBytes, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({
		name: "HKDF",
		hash: "SHA-256",
		salt: new Uint8Array(0),
		info: new TextEncoder().encode(CONTENT_KEY_HKDF_INFO)
	}, ikm, CONTENT_KEY_HMAC_BITS);
	try {
		return await crypto.subtle.importKey("raw", bits, {
			name: "HMAC",
			hash: "SHA-256"
		}, false, ["sign"]);
	} finally {
		new Uint8Array(bits).fill(0);
	}
};
/**
* Derive the content-key (the object-path segment, §10) for a block's bytes.
* Plaintext → the raw sha256 hex (the server already holds those bytes);
* E2EE → `hex(HMAC(K_id, sha256))` at FULL length (never truncated — truncation
* only invites two plaintexts to collide on one path). Throws when an E2EE
* derivation has no K_id, so the resolver fails closed.
*/
var deriveContentKey = async (ref) => {
	const digest = digestFromContentHash(ref.contentHash);
	if (ref.mode === "none") return bytesToHex(digest);
	if (!ref.contentKeyHmac) throw new Error("content key: e2ee workspace has no K_id (re-paste the workspace key)");
	const mac = await crypto.subtle.sign("HMAC", ref.contentKeyHmac, digest);
	return bytesToHex(new Uint8Array(mac));
};
//#endregion
export { deriveContentKey, deriveContentKeyHmac };

//# sourceMappingURL=contentKey.js.map