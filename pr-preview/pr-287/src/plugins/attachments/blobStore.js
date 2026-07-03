import { attachmentObjectPath } from "./storagePaths.js";
//#region src/plugins/attachments/blobStore.ts
var ATTACHMENTS_BUCKET = "attachments";
/**
* A failed upload. `permanent` tells the §9 up-lane whether to quarantine the
* record as `failed` (an auth/path/size rejection that won't clear on retry) or
* keep it `pending` and retry with backoff (network / 5xx / a momentarily-absent
* or expired session).
*
* `permanent` is an ADVISORY fast-path quarantine hint, NOT the sole exit from
* the retry loop: only the enumerated permanent statuses/codes (403/404/413 and
* AccessDenied/NoSuchBucket/EntityTooLarge) set it, so a permanent failure
* outside that set (e.g. a stray 400-family `InvalidKey`) would otherwise retry
* forever. The §9 up-lane MUST therefore bound retries by attempt count / age
* regardless of `permanent` (the §9/§17 bounded-correction→`failed` rule) —
* `permanent` only lets it quarantine sooner.
*/
var BlobPutError = class extends Error {
	constructor(message, permanent, status, code) {
		super(message);
		this.permanent = permanent;
		this.status = status;
		this.code = code;
		this.name = "BlobPutError";
	}
};
/** Permanent HTTP statuses — won't clear on retry → the §9 record goes to
*  `failed`: 403 not-a-writer / removed member, 404 bucket missing (misconfig),
*  413 over the bucket's file_size_limit. */
var PERMANENT_HTTP_STATUSES = new Set([
	403,
	404,
	413
]);
/** The symbolic siblings of those statuses (the word-code shape). */
var PERMANENT_STORAGE_CODES = new Set([
	"AccessDenied",
	"NoSuchBucket",
	"EntityTooLarge"
]);
/** Duplicate-object codes (the symbolic shape's 409). */
var ALREADY_EXISTS_CODES = new Set([
	"ResourceAlreadyExists",
	"KeyAlreadyExists",
	"Duplicate"
]);
/** The real HTTP status of a Storage error: a numeric `statusCode` when present
*  (the shape that puts the code there), else `.status` (the shape that puts a
*  word in `statusCode`). */
var httpStatusOf = (err) => {
	const sc = err.statusCode != null ? String(err.statusCode) : void 0;
	if (sc != null && /^\d+$/.test(sc)) return Number(sc);
	return err.status;
};
/** Storage "object already exists" — a first-write-wins SUCCESS, not an error
*  (§10.1): HTTP 409, or the symbolic `ResourceAlreadyExists` / `KeyAlreadyExists`.
*  Detect it so an unrelated error can't be mis-read as an idempotent success
*  (which would clear the §9 queue against an object that was never written).
*  Exported so the RLS verifier (scripts/attachments-rls-verify.ts) classifies the
*  first-write-wins re-upload through the SAME predicate it's meant to validate,
*  instead of a drifting copy of the code set. */
var isAlreadyExists = (err) => {
	const sc = err.statusCode != null ? String(err.statusCode) : "";
	return sc === "409" || err.status === 409 || ALREADY_EXISTS_CODES.has(sc);
};
/** Object-not-found codes (a download's symbolic 404). */
var NOT_FOUND_STORAGE_CODES = new Set([
	"NoSuchKey",
	"NotFound",
	"KeyNotFound"
]);
/** Storage "object not found" — a DEFINITIVE 404 on a GET/download, i.e. the content
*  path is FREE (the §9 recovery probe re-drives on it). Detected on BOTH the real HTTP
*  status (via {@link httpStatusOf}, so a numeric `statusCode: '404'` flattened onto
*  `.status: 400` is still caught) AND the symbolic word-code shape — the same
*  dual-shape robustness {@link isAlreadyExists} needs. Anything NOT matched here stays
*  a throw the probe treats as transient (offline / 5xx / unknown) — recovery must not
*  read an ambiguous error as "path free". (A genuinely RLS-DENIED read is NOT such an
*  error: Storage hides existence, so it returns a 404-shape that DOES match here → null;
*  see {@link BlobStore.probe}.) Module-private — only `probe` consumes it
*  (unlike `isAlreadyExists`, which the off-path RLS verifier also uses). */
var isObjectNotFound = (err) => {
	const sc = err.statusCode != null ? String(err.statusCode) : void 0;
	return httpStatusOf(err) === 404 || sc != null && NOT_FOUND_STORAGE_CODES.has(sc);
};
var createSupabaseBlobStore = (deps) => {
	const objectPath = attachmentObjectPath;
	const { client, getAccessToken } = deps;
	return {
		async put(workspaceId, contentKey, bytes) {
			if (!await getAccessToken()) throw new BlobPutError("no active session", false, 401, "no_session");
			let error;
			try {
				({error} = await client.storage.from(ATTACHMENTS_BUCKET).upload(objectPath(workspaceId, contentKey), bytes, {
					contentType: "application/octet-stream",
					upsert: false
				}));
			} catch (cause) {
				throw new BlobPutError(`upload network error: ${String(cause)}`, false, void 0, "network");
			}
			if (!error) return "written";
			if (isAlreadyExists(error)) return "exists";
			const sc = error.statusCode != null ? String(error.statusCode) : void 0;
			const status = httpStatusOf(error);
			const permanent = status != null && PERMANENT_HTTP_STATUSES.has(status) || sc != null && PERMANENT_STORAGE_CODES.has(sc);
			throw new BlobPutError(`upload failed${sc != null ? ` (${sc})` : status != null ? ` (${status})` : ""}: ${error.message ?? "unknown error"}`, permanent, status);
		},
		async get(workspaceId, contentKey) {
			const { data, error } = await client.storage.from(ATTACHMENTS_BUCKET).download(objectPath(workspaceId, contentKey));
			if (error) throw error;
			if (!data) throw new Error(`blob get: empty body for ${objectPath(workspaceId, contentKey)}`);
			return new Uint8Array(await data.arrayBuffer());
		},
		async probe(workspaceId, contentKey) {
			const { data, error } = await client.storage.from(ATTACHMENTS_BUCKET).download(objectPath(workspaceId, contentKey));
			if (error) {
				if (isObjectNotFound(error)) return null;
				throw error;
			}
			if (!data) return null;
			return new Uint8Array(await data.arrayBuffer());
		},
		async delete(workspaceId, contentKey) {
			const { error } = await client.storage.from(ATTACHMENTS_BUCKET).remove([objectPath(workspaceId, contentKey)]);
			if (error) throw error;
		}
	};
};
//#endregion
export { ATTACHMENTS_BUCKET, BlobPutError, createSupabaseBlobStore, isAlreadyExists };

//# sourceMappingURL=blobStore.js.map