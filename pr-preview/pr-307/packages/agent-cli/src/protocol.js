import { _enum, array, boolean, discriminatedUnion, literal, looseObject, number, object, record, string, union, unknown } from "../node_modules/zod/v4/classic/schemas.js";
//#region packages/agent-cli/src/protocol.ts
/**
* Wire-protocol schemas shared between the CLI (`cli.ts`) and the
* local bridge HTTP server (`server.ts`). Both ends parse JSON over
* the wire — the schemas here are the single source of truth for the
* shape of those messages, and `z.infer<>` produces the matching
* TypeScript types so neither side drifts.
*
* Conventions:
*   - Use `z.looseObject({...})` for envelopes that pass extra fields
*     through to a downstream handler (notably command bodies, which
*     are forwarded verbatim to the browser-side kernel).
*   - Use plain `z.object({...})` (strip extras) for responses we own
*     end-to-end — the bridge can shed unknown keys silently rather
*     than ferry them to callers.
*/
var tokenScopeSchema = _enum(["read-write", "read-only"]);
var tokenAudienceSchema = object({
	userId: string().nullable(),
	workspaceId: string().nullable()
}).extend({ label: string().nullable() });
looseObject({ type: string() });
var commandIdField = { commandId: string().optional() };
var pingCommandSchema = looseObject({
	type: literal("ping"),
	...commandIdField
});
var runtimeSummaryCommandSchema = looseObject({
	type: literal("runtime-summary"),
	...commandIdField
});
var healthCommandSchema = looseObject({
	type: literal("health"),
	...commandIdField
});
var describeRuntimeCommandSchema = looseObject({
	type: literal("describe-runtime"),
	actions: array(string()).optional(),
	facets: array(string()).optional(),
	guides: array(string()).optional(),
	guide: union([string(), array(string())]).optional(),
	modules: array(string()).optional(),
	components: array(string()).optional(),
	storage: boolean().optional(),
	brief: boolean().optional(),
	...commandIdField
});
var sqlModeSchema = _enum([
	"all",
	"get",
	"optional",
	"execute"
]);
var sqlCommandSchema = looseObject({
	type: literal("sql"),
	sql: string(),
	mode: sqlModeSchema.optional(),
	params: array(unknown()).optional(),
	...commandIdField
});
var getBlockCommandSchema = looseObject({
	type: literal("get-block"),
	id: string().optional(),
	blockId: string().optional(),
	...commandIdField
});
var getSubtreeCommandSchema = looseObject({
	type: literal("get-subtree"),
	rootId: string(),
	...commandIdField
});
var createBlockCommandSchema = looseObject({
	type: literal("create-block"),
	parentId: string().optional(),
	...commandIdField
});
var updateBlockCommandSchema = looseObject({
	type: literal("update-block"),
	id: string().optional(),
	blockId: string().optional(),
	content: string().optional(),
	replaceProperties: boolean().optional(),
	...commandIdField
});
var installExtensionCommandSchema = looseObject({
	type: literal("install-extension"),
	source: string(),
	label: string().optional(),
	description: string().optional(),
	parentId: string().optional(),
	id: string().optional(),
	reload: boolean().optional(),
	verify: boolean().optional(),
	...commandIdField
});
var enableExtensionCommandSchema = looseObject({
	type: literal("enable-extension"),
	id: string().optional(),
	label: string().optional(),
	...commandIdField
});
var disableExtensionCommandSchema = looseObject({
	type: literal("disable-extension"),
	id: string().optional(),
	label: string().optional(),
	...commandIdField
});
/** Legacy alias for enable/disable-extension — accepts an explicit
*  `enabled: boolean` field. Not surfaced in the CLI but kept in the
*  kernel-handled union so older callers (or arbitrary `kmagent raw`
*  bodies) keep working. */
var setExtensionEnabledCommandSchema = looseObject({
	type: literal("set-extension-enabled"),
	id: string().optional(),
	label: string().optional(),
	enabled: boolean(),
	...commandIdField
});
var uninstallExtensionCommandSchema = looseObject({
	type: literal("uninstall-extension"),
	id: string().optional(),
	label: string().optional(),
	...commandIdField
});
var runActionCommandSchema = looseObject({
	type: literal("run-action"),
	id: string(),
	dependencies: record(string(), unknown()).optional(),
	...commandIdField
});
/** Legacy alias — the kernel handles `'action'` the same way as
*  `'run-action'`. Kept in the union so the kernel switch can match
*  it after narrowing. */
var actionCommandSchema = looseObject({
	type: literal("action"),
	id: string(),
	dependencies: record(string(), unknown()).optional(),
	...commandIdField
});
var evalCommandSchema = looseObject({
	type: literal("eval"),
	code: string(),
	/** Structured input bound as `data` in the eval execution scope. The
	*  CLI populates this from `--data <path>` / `--data-json <inline>`;
	*  the kernel passes it through to the user code's destructured
	*  context. JSON-serialized over the wire, so callers should keep
	*  values to JSON-representable types. */
	data: unknown().optional(),
	...commandIdField
});
/** Backlinks for a block. `filter` is either a mode string
*  ('none' | 'stored' | 'effective') or an explicit BacklinksFilter
*  object — validated/coerced kernel-side, so it stays `unknown` here. */
var backlinksCommandSchema = looseObject({
	type: literal("backlinks"),
	id: string().optional(),
	blockId: string().optional(),
	workspaceId: string().optional(),
	filter: unknown().optional(),
	...commandIdField
});
/** Grouped-backlinks (the grouped-references view) for a block.
*  `filter` is as above; `grouping` is a mode string ('user' | 'none')
*  or an explicit grouping-config object. Both coerced kernel-side. */
var groupedBacklinksCommandSchema = looseObject({
	type: literal("grouped-backlinks"),
	id: string().optional(),
	blockId: string().optional(),
	workspaceId: string().optional(),
	filter: unknown().optional(),
	grouping: unknown().optional(),
	...commandIdField
});
/** Print the agent-facing data-model guide. No body beyond the type. */
var dataModelCommandSchema = looseObject({
	type: literal("data-model"),
	...commandIdField
});
/** Resolve a page by alias/title — exact hit plus substring candidates. */
var pageCommandSchema = looseObject({
	type: literal("page"),
	name: string(),
	workspaceId: string().optional(),
	limit: number().optional(),
	...commandIdField
});
/** Resolve a date expression to its daily-note block. `date` accepts
*  today | yesterday | an ISO date | the literal title ("June 17th, 2026")
*  | natural-language ("next monday"). */
var dailyNoteCommandSchema = looseObject({
	type: literal("daily-note"),
	date: string(),
	workspaceId: string().optional(),
	...commandIdField
});
/** Full-text search over block content. */
var searchCommandSchema = looseObject({
	type: literal("search"),
	query: string(),
	workspaceId: string().optional(),
	limit: number().optional(),
	...commandIdField
});
/** Side-effecting SQL functions PowerSync registers on the SAME wa-sqlite
*  connection the bridge uses — `SELECT powersync_clear(1)` wipes local
*  (incl. un-uploaded) data, `powersync_replace_schema` / `_control`
*  corrupt schema/sync state. A `SELECT` prologue does NOT make a
*  statement read-only here, so these must be denied regardless of
*  prologue. Match the bare `powersync_` TOKEN, not `powersync_` + `(`:
*  a SQLite comment counts as whitespace, so a comment wedged between the
*  name and its paren makes a valid call that a `\s*\(` guard would miss
*  — but the function name itself must appear as one contiguous
*  identifier to be callable (a comment can't split it), so the bare
*  token match is comment-proof. The app registers no other writable
*  UDFs (verified), so this family is the whole vector. */
var SIDE_EFFECTING_FN = /\bpowersync_/i;
/** Textual read-only enforcement, shared by every surface that accepts
*  SQL it will run repeatedly or on someone else's authority (the km MCP
*  graph tools, claude-tasks watcher configs, watch-events registrations,
*  the bridge's read-only token scope): single statement, no
*  side-effecting function call, and either a SELECT/PRAGMA-info/EXPLAIN
*  prologue or a WITH containing no mutating keyword — CTEs can head
*  `WITH … UPDATE/INSERT/DELETE`, so `with` alone proves nothing. The
*  keyword/function scan can false-positive on string literals; rewrite
*  the query (or use the write tools) in that case. */
var isReadOnlySql = (sql) => {
	const body = sql.trim().replace(/;\s*$/, "");
	if (body.includes(";")) return false;
	if (SIDE_EFFECTING_FN.test(body)) return false;
	if (/^(select|pragma table_info|explain)\b/i.test(body)) return true;
	if (/^with\b/i.test(body)) return !/\b(insert|update|delete|replace|drop|alter|create|vacuum|attach|detach|reindex)\b/i.test(body);
	return false;
};
var watcherSettleMsField = { 
/** Quiet window: the result set must be stable this long before an
*  event is emitted (restarted on every further change). */
settleMs: number().int().min(0).max(6e5).optional() };
var watchEventsWatcherSchema = discriminatedUnion("kind", [looseObject({
	kind: literal("sql"),
	name: string().min(1),
	sql: string().refine(isReadOnlySql, { message: "watcher sql must be a single read-only statement (SELECT / PRAGMA table_info / EXPLAIN, or a non-mutating WITH)" }),
	params: array(unknown()).optional(),
	/** Tables whose changes re-run the query (default: blocks). */
	tables: array(string().min(1)).max(8).optional(),
	...watcherSettleMsField
}), looseObject({
	kind: literal("backlinks"),
	name: string().min(1),
	targetId: string().min(1),
	...watcherSettleMsField
})]);
/** Replace `consumer`'s whole watcher registration (empty = unregister).
*  Registrations live in the tab: they die with it and expire after
*  `ttlMs` without a refresh, so consumers re-send this periodically. */
var watchEventsCommandSchema = looseObject({
	type: literal("watch-events"),
	consumer: string().min(1),
	watchers: array(watchEventsWatcherSchema).max(64).refine((watchers) => new Set(watchers.map((watcher) => watcher.name)).size === watchers.length, { message: "watcher names must be unique within a registration" }),
	ttlMs: number().int().min(1e3).max(24 * 36e5).optional(),
	...commandIdField
});
discriminatedUnion("type", [
	pingCommandSchema,
	runtimeSummaryCommandSchema,
	healthCommandSchema,
	describeRuntimeCommandSchema,
	sqlCommandSchema,
	getBlockCommandSchema,
	getSubtreeCommandSchema,
	createBlockCommandSchema,
	updateBlockCommandSchema,
	installExtensionCommandSchema,
	enableExtensionCommandSchema,
	disableExtensionCommandSchema,
	uninstallExtensionCommandSchema,
	runActionCommandSchema,
	evalCommandSchema,
	backlinksCommandSchema,
	groupedBacklinksCommandSchema,
	dataModelCommandSchema,
	pageCommandSchema,
	dailyNoteCommandSchema,
	searchCommandSchema,
	watchEventsCommandSchema
]);
/** Full set of commands the kernel handles — canonical + legacy
*  aliases (`set-extension-enabled`, `action`). Used by the bridge
*  to validate incoming commands and by the kernel's executeCommand
*  switch for exhaustive narrowing. */
var knownAgentCommandSchema = discriminatedUnion("type", [
	pingCommandSchema,
	runtimeSummaryCommandSchema,
	healthCommandSchema,
	describeRuntimeCommandSchema,
	sqlCommandSchema,
	getBlockCommandSchema,
	getSubtreeCommandSchema,
	createBlockCommandSchema,
	updateBlockCommandSchema,
	installExtensionCommandSchema,
	enableExtensionCommandSchema,
	disableExtensionCommandSchema,
	setExtensionEnabledCommandSchema,
	uninstallExtensionCommandSchema,
	runActionCommandSchema,
	actionCommandSchema,
	evalCommandSchema,
	backlinksCommandSchema,
	groupedBacklinksCommandSchema,
	dataModelCommandSchema,
	pageCommandSchema,
	dailyNoteCommandSchema,
	searchCommandSchema,
	watchEventsCommandSchema
]);
/** Schema-derived registry of every known wire command. Typed as
*  `Record<KnownCommandType, …>` so adding a variant to
*  `knownCommandSchema` without a registry entry is a TypeScript
*  error — the two sources of truth stay structurally in sync.
*
*  Consumers should reach for `getCommandMeta(type)` when they want a
*  specific entry, or iterate over the registry's entries (e.g. to
*  build a CLI help list, a runtime-summary hint set, or a README
*  cheatsheet). */
var knownCommandRegistry = {
	"ping": {
		usage: "kmagent ping",
		description: "Ping the bridge + runtime; print a status summary.",
		readOnly: true
	},
	"runtime-summary": {
		usage: "kmagent runtime-summary",
		description: "Compact agent-oriented runtime context.",
		readOnly: true
	},
	"health": {
		usage: "kmagent health",
		description: "Layout B sync-health snapshot: app-visible block count vs blocks_synced, distinct blocks queued for upload, and the materialization backlog. One read to triage a stuck or unsynced client (healthy = both queues 0 and blocks ≈ blocks_synced).",
		readOnly: true
	},
	"describe-runtime": {
		usage: "kmagent describe-runtime [--actions <text>] [--facets <text>] [--guide <id>] [--modules <text>] [--components <text>] [--storage]",
		description: "Show full or targeted runtime diagnostics. Canonical \"what is registered\" view — prefer over reaching into facetRuntime/Repo internals via eval. When --guide is passed alone, defaults to brief output; pass --full to include actions/facets/modules/components too.",
		readOnly: true
	},
	"sql": {
		usage: "kmagent sql <all|get|optional|execute> <sql> [paramsJson]",
		description: "Run SQL (mode: all|get|optional|execute).",
		readOnly: false
	},
	"get-block": {
		usage: "kmagent get-block <id>",
		description: "Fetch a block by id.",
		readOnly: true
	},
	"get-subtree": {
		usage: "kmagent subtree <rootId> [--json]",
		description: "Fetch the subtree rooted at <rootId> (root included). Prints a depth-indented `- [id] content` outline by default (one line per block, id first); --json returns the raw flat array (each row carries its depth from the root). Both are a pre-order traversal with siblings in (order_key, id) order — already sorted; read top-to-bottom, do not re-sort.",
		readOnly: true
	},
	"create-block": {
		usage: "kmagent create-block <json>",
		description: "Create a block (body shape per <json>).",
		readOnly: false
	},
	"update-block": {
		usage: "kmagent update-block <json>",
		description: "Update a block (body shape per <json>).",
		readOnly: false
	},
	"install-extension": {
		usage: "kmagent install-extension [--verify] [--description <text>] <file> [label]",
		description: "Install a JS extension. Reload is automatic; --verify reports the contributed facets/actions; label defaults to the filename without ext.",
		readOnly: false
	},
	"enable-extension": {
		usage: "kmagent enable-extension <id|label>",
		description: "Enable an installed extension by id or label. Sets the synced enabled intent AND approves the current source on this device (pins its hash) so it runs here. Re-run after editing the source to re-pin the new version.",
		readOnly: false
	},
	"disable-extension": {
		usage: "kmagent disable-extension <id|label>",
		description: "Disable an installed extension by id or label (clears the synced intent; the device trust grant persists for a frictionless re-enable).",
		readOnly: false
	},
	"uninstall-extension": {
		usage: "kmagent uninstall-extension <id|label>",
		description: "Uninstall an extension by id or label (deletes the block and revokes this device’s trust grant).",
		readOnly: false
	},
	"run-action": {
		usage: "kmagent run-action <id> [depsJson]",
		description: "Run a registered action by id.",
		readOnly: false
	},
	"eval": {
		usage: "kmagent eval [--raw] [--file <path>] [--data <path> | --data-json <json>] <code>",
		description: "Run JS in the app. Use \"return …\" to print a value. The code runs with `repo`, `db`, `runtime`, `sql`, `block`, `getBlock`, `getSubtree`, `createBlock`, `updateBlock`, `installExtension`, `setExtensionEnabled`, `uninstallExtension`, `actions`, `renderers`, `refreshAppRuntime`, `React`, `ReactDOM`, `window`, `document` already in scope. `--data <path>` reads JSON from a file (or `--data-json <inline>` for an inline payload) and binds the parsed value as `data` — avoids template-embedding structured input in the code string.",
		readOnly: false
	},
	"backlinks": {
		usage: "kmagent backlinks <blockId> [--filter none|stored|effective|<json>] [--workspace <id>]",
		description: "Hydrated backlinks of a block (blocks whose references point at it). --filter defaults to none. See `kmagent data-model`.",
		readOnly: true
	},
	"grouped-backlinks": {
		usage: "kmagent grouped-backlinks <blockId> [--filter none|stored|effective|<json>] [--grouping user|none|<json>] [--workspace <id>]",
		description: "The grouped-references view for a block: hydrated groups (+ Other fallback). --grouping defaults to the user config (matches the UI); --filter defaults to none. See `kmagent data-model`.",
		readOnly: true
	},
	"data-model": {
		usage: "kmagent data-model",
		description: "Print the agent-facing data-model guide (blocks, references, pages/daily-notes, backlinks vs grouped-backlinks, source_field, done-status, deep-links). Read this first when working with a user's data.",
		readOnly: true
	},
	"page": {
		usage: "kmagent page <name> [--limit <n>] [--workspace <id>]",
		description: "Resolve a page by alias/title: exact match plus substring candidates, hydrated.",
		readOnly: true
	},
	"daily-note": {
		usage: "kmagent daily-note <date> [--workspace <id>]",
		description: "Resolve a date (today | yesterday | 2026-06-18 | \"June 17th, 2026\" | \"next monday\") to its daily-note block (deterministic id; reports whether it exists yet).",
		readOnly: true
	},
	"search": {
		usage: "kmagent search <query> [--limit <n>] [--workspace <id>]",
		description: "Full-text search over block content; hydrated results.",
		readOnly: true
	},
	"watch-events": {
		usage: "kmagent raw '{\"type\":\"watch-events\",\"consumer\":\"...\",\"watchers\":[...]}'",
		description: "Replace a consumer's change-watcher registration in the tab; matching changes are pushed to the bridge events channel (GET /runtime/events/next).",
		readOnly: false
	}
};
/** Lookup helper for surfaces that want a single command's metadata.
*  Type-safe — TypeScript guarantees every `KnownCommandType` resolves. */
var getCommandMeta = (type) => knownCommandRegistry[type];
var commandStatusSchema = _enum([
	"pending",
	"delivered",
	"completed",
	"failed"
]);
/**
* What the kernel returns inside a command result envelope. The
* `value` (on ok) and `error.message` (on failure) are the only
* fields the CLI reads directly; everything else stays opaque.
*/
var commandResultSchema = object({
	ok: boolean(),
	value: unknown().optional(),
	error: object({
		name: string().optional(),
		message: string().optional()
	}).loose().optional()
}).nullable();
object({
	id: string(),
	status: commandStatusSchema,
	result: commandResultSchema,
	clientId: string().nullable(),
	targetClientId: string(),
	createdAt: number(),
	deliveredAt: number().nullable(),
	completedAt: number().nullable()
});
object({
	clientId: string(),
	audience: tokenAudienceSchema,
	scope: tokenScopeSchema,
	connected: boolean(),
	clientLastSeen: number().nullable()
});
looseObject({
	token: string().min(1),
	userId: string().optional(),
	workspaceId: string().optional(),
	label: string().optional(),
	scope: string().optional()
});
looseObject({
	tokens: array(unknown()).optional(),
	audience: looseObject({
		userId: string().optional(),
		workspaceId: string().optional()
	}).optional()
});
//#endregion
export { getCommandMeta, knownAgentCommandSchema };

//# sourceMappingURL=protocol.js.map