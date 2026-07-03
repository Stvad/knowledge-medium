import { truncate } from "../../utils/string.js";
//#region src/plugins/system-status/rejectedHelpers.ts
/** Helpers for rendering `ps_crud_rejected` rows in the UI.
*
*  Two formats are normalised here so the dialog stays simple:
*  - `error_message` from Supabase comes back as the JSON-stringified
*    PostgrestError shape `{code, details, hint, message}` rather than
*    a flat human sentence. Unwrap once so the dialog can show the
*    user-facing `message` prominently and keep the rest collapsed.
*  - `data` is the upload envelope `{op, type, id, data}`. Render a
*    short op summary so a row reads as "PUT blocks abc12345…" at a
*    glance without expanding into the full payload. */
var parseRejectionError = (raw) => {
	if (raw === null || raw === "") return {
		message: "(no error message)",
		code: null,
		details: null,
		hint: null
	};
	try {
		const parsed = JSON.parse(raw);
		return {
			message: pickString(parsed, "message") ?? raw,
			code: pickString(parsed, "code"),
			details: pickString(parsed, "details"),
			hint: pickString(parsed, "hint")
		};
	} catch {
		return {
			message: raw,
			code: null,
			details: null,
			hint: null
		};
	}
};
var pickString = (obj, key) => {
	const value = obj[key];
	return typeof value === "string" && value.length > 0 ? value : null;
};
var summarizeOp = (rawData) => {
	try {
		const parsed = JSON.parse(rawData);
		const op = pickString(parsed, "op") ?? "OP";
		const table = pickString(parsed, "type") ?? "unknown";
		const id = pickString(parsed, "id") ?? "(no id)";
		return {
			op,
			table,
			id,
			idShort: shortenId(id)
		};
	} catch {
		return {
			op: "OP",
			table: "unknown",
			id: rawData,
			idShort: shortenId(rawData)
		};
	}
};
var shortenId = (id) => {
	if (id.length <= 13) return id;
	return `${id.slice(0, 8)}…${id.slice(-4)}`;
};
var CONTENT_COLUMNS = [
	"content",
	"properties_json",
	"references_json"
];
var ENC_V1_PREFIX = "enc:v1:";
var CONTENT_PREVIEW_MAX = 80;
var isRecord = (value) => typeof value === "object" && value !== null;
var extractBlockDetails = (rawData) => {
	const empty = {
		workspaceId: null,
		fields: [],
		contentPreview: null,
		encrypted: false
	};
	try {
		const parsed = JSON.parse(rawData);
		const data = isRecord(parsed.data) ? parsed.data : {};
		const content = typeof data.content === "string" ? data.content : null;
		const encrypted = CONTENT_COLUMNS.some((column) => typeof data[column] === "string" && data[column].startsWith(ENC_V1_PREFIX));
		const contentPreview = content && !content.startsWith(ENC_V1_PREFIX) ? truncate(content, CONTENT_PREVIEW_MAX) : null;
		return {
			workspaceId: pickString(data, "workspace_id"),
			fields: Object.keys(data).filter((key) => key !== "workspace_id"),
			contentPreview,
			encrypted
		};
	} catch {
		return empty;
	}
};
//#endregion
export { extractBlockDetails, parseRejectionError, shortenId, summarizeOp };

//# sourceMappingURL=rejectedHelpers.js.map