import { bytesToHex, hexToBytes } from "./hex.js";
//#region src/sync/crypto/contentHash.ts
/**
* The asset content hash (§5.1 / §10): sha256 of the PLAINTEXT bytes, the
* value stored in `block.properties.hash` and the read-side integrity gate.
*
* The read path (§7.3 resolver) verifies decrypted/served bytes against this
* hash before caching or rendering them, and rejects on mismatch — the
* load-bearing defense against an untrusted server returning arbitrary or
* stale bytes for a content path (the AAD binding is redundant-but-cheap
* defense-in-depth, §5.1). The same raw digest seeds the content-addressed
* Storage path (§10): a plaintext workspace uses it directly, an E2EE
* workspace wraps it as HMAC(K_id, …).
*/
/** Prefix tag on the stored hash string — `sha256:<lowercase-hex>`. */
var CONTENT_HASH_PREFIX = "sha256:";
/** Raw sha256 digest length in bytes (sha256 = 256 bits). */
var SHA256_BYTES = 32;
/** Raw sha256 digest of the plaintext bytes (32 bytes). The content-key
*  derivation (§10) consumes this digest; {@link computeContentHash} formats
*  the `block.properties.hash` string from it. */
var sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
/** Format plaintext bytes as the `sha256:<hex>` content-hash string. */
var computeContentHash = async (bytes) => CONTENT_HASH_PREFIX + bytesToHex(await sha256(bytes));
/** Read-side integrity gate (§5.1): do these bytes hash to `expected`? The
*  hash is not a secret (the server already knows the plaintext sha256 for a
*  plaintext workspace), so a plain string compare is sufficient. */
var verifyContentHash = async (bytes, expected) => await computeContentHash(bytes) === expected;
/** Recover the raw 32-byte sha256 digest from a stored `sha256:<hex>` content
*  hash — the inverse of {@link computeContentHash}. The content-key derivation
*  (§10) consumes this digest (raw for a plaintext workspace, HMAC'd for E2EE).
*  Strict: a missing/wrong prefix or a non-32-byte body throws, so a malformed
*  `block.properties.hash` fails closed at the resolver instead of routing to a
*  bogus Storage path. */
var digestFromContentHash = (contentHash) => {
	if (!contentHash.startsWith("sha256:")) throw new Error(`content hash: missing '${CONTENT_HASH_PREFIX}' prefix`);
	const body = contentHash.slice(7);
	if (body !== body.toLowerCase()) throw new Error("content hash: expected lowercase hex");
	const digest = hexToBytes(body);
	if (digest.length !== SHA256_BYTES) throw new Error(`content hash: expected ${SHA256_BYTES}-byte digest, got ${digest.length}`);
	return digest;
};
//#endregion
export { computeContentHash, digestFromContentHash, verifyContentHash };

//# sourceMappingURL=contentHash.js.map