import { base32nopad } from "../../../node_modules/@scure/base/index.js";
//#region src/sync/crypto/base32.ts
/**
* Base32 (RFC 4648, no padding) for the user-facing workspace-key format
* `kmp-wk-1:<base32>` (§5/§6). Base32 is paste-friendly across messaging
* apps and legible on paper; 32 key bytes encode to 52 chars.
*
* Thin wrapper over `@scure/base` (audited, zero-dep). scure's
* `base32nopad` is case-SENSITIVE on decode, so we upper-case first to
* keep paste tolerance (users retype keys). The caller
* (./workspaceKey.ts) asserts the decoded byte length.
*/
var bytesToBase32 = (bytes) => base32nopad.encode(bytes);
var base32ToBytes = (value) => {
	try {
		return Uint8Array.from(base32nopad.decode(value.toUpperCase()));
	} catch (cause) {
		throw new Error(`base32: invalid input`, { cause });
	}
};
//#endregion
export { base32ToBytes, bytesToBase32 };

//# sourceMappingURL=base32.js.map