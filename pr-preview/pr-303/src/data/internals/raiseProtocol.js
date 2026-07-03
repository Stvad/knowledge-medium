//#region src/data/internals/raiseProtocol.ts
/**
* Owner module for the SQLite-trigger → JS error-translation protocol.
*
* Two storage-layer integrity triggers RAISE a structured message that
* `repo.tx` catches and re-throws as a typed user-domain error:
*
*   - `block_aliases_workspace_alias_unique` → `alias_collision` →
*     `ProcessorRejection('alias.collision', …)`
*   - `blocks_parent_not_deleted_check_{insert,update}` → `parent_deleted`
*     → `ParentDeletedError(parentId)`
*
* The wire format spans two files — `clientSchema.ts` emits the RAISE
* string inside the trigger SQL, `repo.ts` parses it back — so the
* separator, the field-encoding, and the prefixes all live here. The SQL
* side imports `RAISE_FIELD_SEP_SQL` + the prefixes; the JS side imports
* the parsers. Neither side hard-codes the contract, so they can't drift.
*/
var RAISE_FIELD_SEP = "";
/** SQL fragment that produces the field separator inside a RAISE
*  expression — derived from `RAISE_FIELD_SEP` so the SQL and JS sides
*  share one source of truth for the delimiter byte. */
var RAISE_FIELD_SEP_SQL = `char(${"".charCodeAt(0)})`;
var ALIAS_COLLISION_RAISE_PREFIX = "alias_collision";
var PARENT_DELETED_RAISE_PREFIX = "parent_deleted";
/** Decode SQLite's `hex()` output (uppercase hex of the UTF-8 bytes)
*  back to the original string. Empty input decodes to `''`. */
var decodeHexUtf8 = (hex) => {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	return new TextDecoder().decode(bytes);
};
/** Recognise the trigger-raised parent-deleted error from
*  `blocks_parent_not_deleted_check_{insert,update}`. The payload is
*  the bare parent id — block ids are UUIDs or deterministic ids
*  (hex + `:` / `-`), so the unit separator never appears in them
*  and the hex encoding the alias parser needs isn't required here.
*  Returns the parsed id on match, `null` otherwise. */
var parseParentDeletedError = (err) => {
	if (err === null || typeof err !== "object") return null;
	const msg = err.message;
	if (typeof msg !== "string") return null;
	const needle = `${PARENT_DELETED_RAISE_PREFIX}`;
	const idx = msg.indexOf(needle);
	if (idx === -1) return null;
	const parentId = msg.slice(idx + needle.length).split("")[0];
	if (parentId.length === 0) return null;
	return { parentId };
};
/** Recognise the trigger-raised alias-collision error inside whatever
*  wrapping SQLite + better-sqlite3 + PowerSync layer it on. Returns
*  parsed fields when matched, `null` otherwise (the caller falls
*  back to its existing error handling). The three field values are
*  hex-encoded in the RAISE message so the unit-separator can be
*  used as a delimiter regardless of what bytes the alias text
*  contains. */
var parseAliasCollisionError = (err) => {
	if (err === null || typeof err !== "object") return null;
	const msg = err.message;
	if (typeof msg !== "string") return null;
	const needle = `${ALIAS_COLLISION_RAISE_PREFIX}`;
	const idx = msg.indexOf(needle);
	if (idx === -1) return null;
	const parts = msg.slice(idx + needle.length).split("");
	if (parts.length < 3) return null;
	const trimToHex = (s) => {
		const m = s.match(/^[0-9A-Fa-f]*/);
		const hex = m === null ? "" : m[0];
		return hex.length % 2 === 0 ? hex : hex.slice(0, -1);
	};
	try {
		return {
			workspaceId: decodeHexUtf8(trimToHex(parts[0])),
			alias: decodeHexUtf8(trimToHex(parts[1])),
			attemptedBlockId: decodeHexUtf8(trimToHex(parts[2]))
		};
	} catch {
		return null;
	}
};
//#endregion
export { ALIAS_COLLISION_RAISE_PREFIX, PARENT_DELETED_RAISE_PREFIX, RAISE_FIELD_SEP, RAISE_FIELD_SEP_SQL, parseAliasCollisionError, parseParentDeletedError };

//# sourceMappingURL=raiseProtocol.js.map