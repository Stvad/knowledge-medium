//#region src/utils/localDbCorruption.ts
/**
* Detect an unrecoverable local-database open failure (SQLite corruption) and
* carry it to the error boundary as a typed, recoverable error.
*
* Why a dedicated type: the bootstrap error boundary needs to tell "the local
* SQLite file is structurally broken" (offer Export + Reset) apart from any
* other bootstrap failure (offer only Reload / Sign out). It also needs the
* `userId` to locate the OPFS `.db` file, which isn't on the raw SQLite error.
*
* This module is intentionally dependency-free (no repoProvider import) so the
* DB-open path can import it without a cycle.
*/
var CORRUPTION_SUBSTRINGS = [
	"disk image is malformed",
	"malformed database schema",
	"not a database",
	"database corruption",
	"sqlite_corrupt",
	"sqlite_notadb",
	"sqlite call returned corrupt"
];
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var messageChainOf = (error, depth = 5) => {
	if (depth <= 0 || error === null || error === void 0) return "";
	if (error instanceof Error) {
		const cause = error.cause;
		return cause === void 0 ? error.message : `${error.message}\n${messageChainOf(cause, depth - 1)}`;
	}
	return String(error);
};
/** True when `error` reads like an unrecoverable SQLite-corruption open failure. */
var isLocalDbCorruptionError = (error) => {
	const msg = messageChainOf(error).toLowerCase();
	return CORRUPTION_SUBSTRINGS.some((s) => msg.includes(s));
};
/**
* Typed local-DB corruption error. Carries the `userId` so the recovery UI can
* resolve the OPFS `.db` file, and the original error as `cause`.
*/
var LocalDatabaseCorruptError = class extends Error {
	userId;
	constructor(userId, options) {
		const cause = options?.cause;
		super(`Local database is corrupted and could not be opened: ${messageOf(cause)}`);
		this.name = "LocalDatabaseCorruptError";
		this.userId = userId;
		if (cause !== void 0) this.cause = cause;
	}
};
/**
* Recognise a `LocalDatabaseCorruptError` even across HMR / bundle boundaries
* where `instanceof` can fail (the class identity differs). Returns the wrapped
* userId, or `null` if `error` isn't a wrapped corruption error.
*/
var corruptErrorUserId = (error) => {
	if (error instanceof LocalDatabaseCorruptError) return error.userId.length > 0 ? error.userId : null;
	if (typeof error === "object" && error !== null && error.name === "LocalDatabaseCorruptError" && typeof error.userId === "string" && error.userId.length > 0) return error.userId;
	return null;
};
/**
* Use at the DB-open boundary: returns a typed `LocalDatabaseCorruptError` (to
* throw) when `error` is a corruption failure, otherwise returns `error`
* unchanged so the caller can rethrow it as-is. Idempotent on an
* already-wrapped error.
*/
var toLocalDbOpenError = (error, userId) => {
	if (corruptErrorUserId(error) !== null) return error;
	if (isLocalDbCorruptionError(error)) return new LocalDatabaseCorruptError(userId, { cause: error });
	return error;
};
//#endregion
export { LocalDatabaseCorruptError, corruptErrorUserId, isLocalDbCorruptionError, toLocalDbOpenError };

//# sourceMappingURL=localDbCorruption.js.map