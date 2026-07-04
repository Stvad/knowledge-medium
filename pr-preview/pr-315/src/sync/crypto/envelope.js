import { base64UrlToBytes, bytesToBase64Url } from "./base64url.js";
//#region src/sync/crypto/envelope.ts
/**
* The `enc:v1:` ciphertext envelope (§6 "Ciphertext format").
*
*   "enc:v1:" + base64url(nonce ‖ ciphertext)
*
* The envelope carries ONLY nonce ‖ ciphertext — no separate version
* field — so a decryptor reconstructs the AAD's `schema_version` from
* the `v1` tag alone (§6). `ciphertext` here is WebCrypto's AES-GCM
* output, i.e. ciphertext bytes with the 16-byte auth tag appended.
*
* The prefix is a FORMAT tag and sanity check, NOT a decrypt trigger:
* per §6 only the durable local mode pin decides whether a value should
* be decrypted. A plaintext-workspace value that happens to start with
* `enc:v1:` is left untouched by the seam.
*/
var ENVELOPE_PREFIX = "enc:v1:";
/** Cheap prefix check. Says nothing about whether the payload decodes —
*  use {@link decodeEnvelope} (or the AEAD verify) for that. */
var hasEnvelopePrefix = (value) => value.startsWith(ENVELOPE_PREFIX);
var encodeEnvelope = (nonce, ciphertext) => {
	if (nonce.length !== 12) throw new Error(`envelope: nonce must be 12 bytes, got ${nonce.length}`);
	const payload = new Uint8Array(nonce.length + ciphertext.length);
	payload.set(nonce, 0);
	payload.set(ciphertext, nonce.length);
	return ENVELOPE_PREFIX + bytesToBase64Url(payload);
};
var decodeEnvelope = (value) => {
	if (!hasEnvelopePrefix(value)) throw new Error("envelope: missing enc:v1: prefix");
	const payload = base64UrlToBytes(value.slice(7));
	if (payload.length < 28) throw new Error("envelope: payload too short to hold a nonce and auth tag");
	return {
		nonce: payload.slice(0, 12),
		ciphertext: payload.slice(12)
	};
};
//#endregion
export { ENVELOPE_PREFIX, decodeEnvelope, encodeEnvelope };

//# sourceMappingURL=envelope.js.map