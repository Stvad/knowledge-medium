/** Raw-byte magic for the binary envelope (the 8 ASCII bytes of `encb:v1:`).
*  The byte-lane analog of ENVELOPE_PREFIX. */
var BINARY_ENVELOPE_MAGIC = new TextEncoder().encode("encb:v1:");
var BINARY_MAGIC_BYTES = BINARY_ENVELOPE_MAGIC.length;
/** Bytes the envelope adds on top of the plaintext: magic ‖ nonce ‖ GCM tag (the
*  ciphertext is otherwise the plaintext's own length, so for a payload of L bytes
*  the sealed object is `L + BINARY_ENVELOPE_OVERHEAD_BYTES`). The up-lane sizes
*  the e2ee capture guard by this so a sealed object can't exceed the bucket's
*  file_size_limit — a passthrough (plaintext) object adds nothing. */
var BINARY_ENVELOPE_OVERHEAD_BYTES = BINARY_MAGIC_BYTES + 12 + 16;
/** Smallest possible valid envelope: magic ‖ nonce ‖ (empty ciphertext) ‖ tag —
*  identical to the overhead (empty payload). A blob carrying the magic but
*  shorter than this CANNOT be a real envelope (it can't hold a nonce + auth tag)
*  — it's a truncated/forged object. The off-path audit uses this as a length
*  floor so an `encb:v1:`-prefixed runt can't pass the cheap magic check. Mirrors
*  `decodeBinaryEnvelope`'s payload guard (`payload.length >= NONCE_BYTES + GCM_TAG_BYTES`). */
var BINARY_ENVELOPE_MIN_BYTES = BINARY_ENVELOPE_OVERHEAD_BYTES;
/** Cheap magic check. Says nothing about whether the payload decodes —
*  use {@link decodeBinaryEnvelope} (or the AEAD verify) for that. */
var hasBinaryEnvelopeMagic = (blob) => {
	if (blob.length < BINARY_MAGIC_BYTES) return false;
	for (let i = 0; i < BINARY_MAGIC_BYTES; i++) if (blob[i] !== BINARY_ENVELOPE_MAGIC[i]) return false;
	return true;
};
var encodeBinaryEnvelope = (nonce, ciphertext) => {
	if (nonce.length !== 12) throw new Error(`binary envelope: nonce must be 12 bytes, got ${nonce.length}`);
	const out = new Uint8Array(BINARY_MAGIC_BYTES + nonce.length + ciphertext.length);
	out.set(BINARY_ENVELOPE_MAGIC, 0);
	out.set(nonce, BINARY_MAGIC_BYTES);
	out.set(ciphertext, BINARY_MAGIC_BYTES + nonce.length);
	return out;
};
var decodeBinaryEnvelope = (blob) => {
	if (!hasBinaryEnvelopeMagic(blob)) throw new Error("binary envelope: missing encb:v1: magic");
	const payload = blob.subarray(BINARY_MAGIC_BYTES);
	if (payload.length < 28) throw new Error("binary envelope: payload too short to hold a nonce and auth tag");
	return {
		nonce: payload.slice(0, 12),
		ciphertext: payload.slice(12)
	};
};
//#endregion
export { BINARY_ENVELOPE_MIN_BYTES, BINARY_ENVELOPE_OVERHEAD_BYTES, decodeBinaryEnvelope, encodeBinaryEnvelope, hasBinaryEnvelopeMagic };

//# sourceMappingURL=binaryEnvelope.js.map