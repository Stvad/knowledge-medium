import { base32ToBytes, bytesToBase32 } from "./base32.js";
//#region src/sync/crypto/workspaceKey.ts
/**
* Workspace key (WK) material and its user-facing format (§5/§6).
*
* The WK is 256 random bits — the only secret in the design. It is
* surfaced to the user once at create as `kmp-wk-1:<base32>` and pasted
* on additional devices. On a device it lives as a NON-EXTRACTABLE
* AES-GCM `CryptoKey` (§5): JS can encrypt/decrypt with it but
* `exportKey` throws, so a hostile script can't dump the bytes for
* offline forever-decryption.
*
* The `kmp-wk-1:` prefix makes a mis-pasted key identifiable; the `1`
* reserves a clean upgrade path.
*/
var WK_PREFIX = "kmp-wk-1:";
/** Fresh 256-bit workspace key material, client-side CSPRNG. */
var generateWorkspaceKeyBytes = () => crypto.getRandomValues(new Uint8Array(32));
/** Render key bytes as the paste-friendly `kmp-wk-1:<base32>` string. */
var formatWorkspaceKey = (bytes) => {
	if (bytes.length !== 32) throw new Error(`workspace key must be 32 bytes, got ${bytes.length}`);
	return WK_PREFIX + bytesToBase32(bytes);
};
/** Parse a pasted `kmp-wk-1:<base32>` string back to key bytes.
*  Tolerates whitespace (including internal) and case: users retype these
*  from paper or paste line-wrapped, and base32 carries no whitespace. */
var parseWorkspaceKey = (value) => {
	const cleaned = value.replace(/\s+/g, "");
	if (cleaned.slice(0, 9).toLowerCase() !== "kmp-wk-1:") throw new Error("workspace key: missing kmp-wk-1: prefix");
	const bytes = base32ToBytes(cleaned.slice(9));
	if (bytes.length !== 32) throw new Error(`workspace key: expected 32 bytes, got ${bytes.length}`);
	return bytes;
};
/** Import raw key bytes as a non-extractable AES-GCM `CryptoKey` (§5). */
var importWorkspaceKey = (bytes) => crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
//#endregion
export { formatWorkspaceKey, generateWorkspaceKeyBytes, importWorkspaceKey, parseWorkspaceKey };

//# sourceMappingURL=workspaceKey.js.map