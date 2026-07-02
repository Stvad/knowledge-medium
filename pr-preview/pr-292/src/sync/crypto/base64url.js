import { base64urlnopad } from "../../../node_modules/@scure/base/index.js";
//#region src/sync/crypto/base64url.ts
/**
* Base64url (RFC 4648 §5, URL-safe alphabet, no padding) for the
* `enc:v1:` ciphertext envelope (see ./envelope.ts).
*
* Thin wrapper over `@scure/base` (audited, zero-dep) so we don't carry a
* hand-rolled codec. Wire envelopes must be paste-safe and free of
* `+`/`/`/`=`, which `base64urlnopad` gives directly. Decoding is strict
* (scure rejects any out-of-alphabet char and excess padding); we surface
* those as a single `Error` so callers — and the AEAD verify in ./aead.ts,
* the real integrity gate — see a uniform failure.
*/
var bytesToBase64Url = (bytes) => base64urlnopad.encode(bytes);
var base64UrlToBytes = (value) => {
	try {
		return Uint8Array.from(base64urlnopad.decode(value));
	} catch (cause) {
		throw new Error(`base64url: invalid input`, { cause });
	}
};
//#endregion
export { base64UrlToBytes, bytesToBase64Url };

//# sourceMappingURL=base64url.js.map