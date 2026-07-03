import { createClient } from "../../../../node_modules/@supabase/supabase-js/dist/index.js";
import { authenticatedObjectUrl } from "../storagePaths.js";
import { BINARY_ENVELOPE_MIN_BYTES, hasBinaryEnvelopeMagic } from "../../../sync/crypto/binaryEnvelope.js";
import { collectPaged } from "./paginate.js";
//#region src/plugins/attachments/audit/supabaseAuditIO.ts
var BUCKET = "attachments";
var PAGE = 1e3;
/**
* The real {@link AuditIO}, backed by supabase-js for the metadata listing (auth
* headers, query building, typed errors handled by the client) and a single
* raw Range-GET for the byte peek (supabase-js `download` has no Range option).
*
* Both list paths are paginated through {@link collectPaged} with an EXPLICIT
* stable sort (`order('id')` / `sortBy: name.asc`) — offset pagination over an
* unordered result can silently skip rows.
*/
function createSupabaseAuditIO(deps) {
	const client = deps.client ?? createClient(deps.url, deps.secretKey);
	const fetchFn = deps.fetchFn ?? fetch;
	const base = deps.url.replace(/\/$/, "");
	const authHeaders = {
		apikey: deps.secretKey,
		authorization: `Bearer ${deps.secretKey}`
	};
	return {
		async listE2eeWorkspaceIds() {
			return collectPaged(async (offset) => {
				const { data, error } = await client.from("workspaces").select("id").eq("encryption_mode", "e2ee").order("id", { ascending: true }).range(offset, offset + PAGE - 1);
				if (error) throw new Error(`workspaces query failed (${error.code || "error"})`);
				return (data ?? []).map((w) => w.id);
			});
		},
		async listObjects(workspaceId) {
			return collectPaged(async (offset) => {
				const { data, error } = await client.storage.from(BUCKET).list(workspaceId, {
					limit: PAGE,
					offset,
					sortBy: {
						column: "name",
						order: "asc"
					}
				});
				if (error) throw new Error(`storage list failed (${error.name || "error"})`);
				return (data ?? []).map((o) => ({
					name: o.name,
					isFolder: o.id === null
				}));
			});
		},
		async readObjectVerdict(path) {
			try {
				const res = await fetchFn(authenticatedObjectUrl(base, BUCKET, path), { headers: {
					...authHeaders,
					range: `bytes=0-${BINARY_ENVELOPE_MIN_BYTES - 1}`
				} });
				if (res.status === 404) return "gone";
				if (!res.ok) return "unreadable";
				const head = new Uint8Array(await res.arrayBuffer());
				return hasBinaryEnvelopeMagic(head) && head.length >= BINARY_ENVELOPE_MIN_BYTES ? "ok" : "plaintext";
			} catch {
				return "unreadable";
			}
		}
	};
}
//#endregion
export { createSupabaseAuditIO };

//# sourceMappingURL=supabaseAuditIO.js.map