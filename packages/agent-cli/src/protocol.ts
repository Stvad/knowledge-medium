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
import {z} from 'zod'

// ---------- Token / audience ----------

export const tokenScopeSchema = z.enum(['read-write', 'read-only'])
export type TokenScope = z.infer<typeof tokenScopeSchema>

export const audienceSchema = z.object({
  userId: z.string().nullable(),
  workspaceId: z.string().nullable(),
})
export type Audience = z.infer<typeof audienceSchema>

export const tokenAudienceSchema = audienceSchema.extend({
  label: z.string().nullable(),
})
export type TokenAudience = z.infer<typeof tokenAudienceSchema>

// ---------- Command envelopes ----------

/**
 * Wire envelope for every command body POSTed to /runtime/commands.
 * Only the `type` discriminator is mandatory; the rest of the keys
 * are command-specific and pass through to the kernel handler.
 *
 * This is the *bridge-side* schema — intentionally loose so the bridge
 * forwards anything with a string `type` to the kernel. The strict,
 * per-verb shapes live in `knownCommandSchema` below and are what CLI
 * construction sites + the kernel dispatch switch type-check against.
 */
export const commandPayloadSchema = z.looseObject({
  type: z.string(),
})
export type CommandPayload = z.infer<typeof commandPayloadSchema>

// ---------- Known command discriminated union ----------
//
// Each branch below pins the body shape for a specific kernel handler.
// The bridge keeps using `commandPayloadSchema` for wire-level
// validation (so an extension can `kmagent raw '{"type":...}'` an
// unknown command and have it forwarded to the kernel for a clearer
// error). The strict per-verb schemas are for:
//   - The CLI: `runCommand(cmd: KnownCommand)` checks construction
//     sites against the right shape at compile time.
//   - The kernel: `executeCommand(cmd: KnownAgentCommand)` narrows
//     inside the switch so each case sees only the fields it should.
//
// `commandId` is appended by the bridge when forwarding, so it's
// optional on every variant — CLI callers don't set it; the kernel
// always sees it.

const commandIdField = {commandId: z.string().optional()}

// All variant schemas use `looseObject` so the kernel's existing
// field-access fallbacks (e.g. `command.id ?? command.actionId`,
// `command.blockId` for get-block, `command.properties` on
// create/update-block) keep working when the dispatch switch
// narrows. Declared fields are still type-checked; extras flow
// through as `unknown` via the inferred index signature.

export const pingCommandSchema = z.looseObject({
  type: z.literal('ping'),
  ...commandIdField,
})

export const runtimeSummaryCommandSchema = z.looseObject({
  type: z.literal('runtime-summary'),
  ...commandIdField,
})

export const healthCommandSchema = z.looseObject({
  type: z.literal('health'),
  ...commandIdField,
})

export const describeRuntimeCommandSchema = z.looseObject({
  type: z.literal('describe-runtime'),
  actions: z.array(z.string()).optional(),
  facets: z.array(z.string()).optional(),
  guides: z.array(z.string()).optional(),
  // Kernel also accepts a singular `guide` (string or array) for
  // back-compat; the CLI always sends `guides` after cac parsing.
  guide: z.union([z.string(), z.array(z.string())]).optional(),
  modules: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  storage: z.boolean().optional(),
  brief: z.boolean().optional(),
  ...commandIdField,
})

export const sqlModeSchema = z.enum(['all', 'get', 'optional', 'execute'])
export type SqlMode = z.infer<typeof sqlModeSchema>

export const sqlCommandSchema = z.looseObject({
  type: z.literal('sql'),
  sql: z.string(),
  mode: sqlModeSchema.optional(),
  params: z.array(z.unknown()).optional(),
  /** Override the kernel's refusal to write to a synced table (`blocks`,
   *  `workspaces`, `workspace_members`) via raw SQL — such a write bypasses
   *  repo.tx, so it never uploads and skips the kernel derivations. Unset
   *  (or false) keeps the guard on; true is a deliberate, one-call opt-out
   *  (the CLI's `--allow-synced-write`). */
  allowSyncedWrite: z.boolean().optional(),
  ...commandIdField,
})

export const getBlockCommandSchema = z.looseObject({
  type: z.literal('get-block'),
  // Either id or blockId — the kernel handler accepts both. Keeping
  // both optional + a refine at the union level would break
  // discriminatedUnion, so we leave the constraint to runtime.
  id: z.string().optional(),
  blockId: z.string().optional(),
  ...commandIdField,
})

export const getSubtreeCommandSchema = z.looseObject({
  type: z.literal('get-subtree'),
  rootId: z.string(),
  ...commandIdField,
})

export const createBlockCommandSchema = z.looseObject({
  type: z.literal('create-block'),
  parentId: z.string().optional(),
  // position, content, properties forwarded verbatim (looseObject).
  ...commandIdField,
})

/** Reconcile a keyed block SUBTREE under `parentId` to match `markdown`,
 *  in one transaction. The markdown is parsed with the app's own paste
 *  parser so the split matches "paste as markdown" exactly. Every block of
 *  the subtree is tagged with `key`, and the app makes the tagged subtree
 *  EQUAL the parsed tree — creating, updating, re-ordering, and (on `final`)
 *  deleting to converge. Idempotent by that key: re-sending the same
 *  markdown lands the same tree, no duplication, so a transient failure is
 *  safe to retry. `shape: 'block'` keeps the whole markdown as ONE block
 *  (no outline split); `'outline'` (default) splits along the markdown
 *  outline. `properties` (looseObject passthrough) is applied to every
 *  block — the dispatch daemon uses it to tag `claude:reply`. Streaming a
 *  reply calls this repeatedly with the growing text (same key); the last
 *  call passes `final: true`. Replaces the old one-shot
 *  `create-blocks-from-markdown`. */
export const reconcileMarkdownSubtreeCommandSchema = z.looseObject({
  type: z.literal('reconcile-markdown-subtree'),
  parentId: z.string(),
  markdown: z.string(),
  key: z.string(),
  shape: z.enum(['outline', 'block']).optional(),
  final: z.boolean().optional(),
  ...commandIdField,
})

export const updateBlockCommandSchema = z.looseObject({
  type: z.literal('update-block'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  content: z.string().optional(),
  replaceProperties: z.boolean().optional(),
  // properties forwarded verbatim (looseObject).
  ...commandIdField,
})

export const moveBlockPositionSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('first')}),
  z.object({kind: z.literal('last')}),
  z.object({kind: z.literal('before'), siblingId: z.string()}),
  z.object({kind: z.literal('after'), siblingId: z.string()}),
])

export const moveBlockCommandSchema = z.looseObject({
  type: z.literal('move-block'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  parentId: z.string().nullable(),
  position: moveBlockPositionSchema,
  ...commandIdField,
})

export const deleteBlockCommandSchema = z.looseObject({
  type: z.literal('delete-block'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  ...commandIdField,
})

export const restoreBlockCommandSchema = z.looseObject({
  type: z.literal('restore-block'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  ...commandIdField,
})

export const installExtensionCommandSchema = z.looseObject({
  type: z.literal('install-extension'),
  source: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  parentId: z.string().optional(),
  id: z.string().optional(),
  reload: z.boolean().optional(),
  verify: z.boolean().optional(),
  ...commandIdField,
})

export const enableExtensionCommandSchema = z.looseObject({
  type: z.literal('enable-extension'),
  id: z.string().optional(),
  label: z.string().optional(),
  ...commandIdField,
})

export const disableExtensionCommandSchema = z.looseObject({
  type: z.literal('disable-extension'),
  id: z.string().optional(),
  label: z.string().optional(),
  ...commandIdField,
})

/** Legacy alias for enable/disable-extension — accepts an explicit
 *  `enabled: boolean` field. Not surfaced in the CLI but kept in the
 *  kernel-handled union so older callers (or arbitrary `kmagent raw`
 *  bodies) keep working. */
export const setExtensionEnabledCommandSchema = z.looseObject({
  type: z.literal('set-extension-enabled'),
  id: z.string().optional(),
  label: z.string().optional(),
  enabled: z.boolean(),
  ...commandIdField,
})

export const uninstallExtensionCommandSchema = z.looseObject({
  type: z.literal('uninstall-extension'),
  id: z.string().optional(),
  label: z.string().optional(),
  ...commandIdField,
})

export const runActionCommandSchema = z.looseObject({
  type: z.literal('run-action'),
  id: z.string(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  ...commandIdField,
})

/** Legacy alias — the kernel handles `'action'` the same way as
 *  `'run-action'`. Kept in the union so the kernel switch can match
 *  it after narrowing. */
export const actionCommandSchema = z.looseObject({
  type: z.literal('action'),
  id: z.string(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  ...commandIdField,
})

export const evalCommandSchema = z.looseObject({
  type: z.literal('eval'),
  code: z.string(),
  /** Structured input bound as `data` in the eval execution scope. The
   *  CLI populates this from `--data <path>` / `--data-json <inline>`;
   *  the kernel passes it through to the user code's destructured
   *  context. JSON-serialized over the wire, so callers should keep
   *  values to JSON-representable types. */
  data: z.unknown().optional(),
  ...commandIdField,
})

/** Backlinks for a block. `filter` is either a mode string
 *  ('none' | 'stored' | 'effective') or an explicit BacklinksFilter
 *  object — validated/coerced kernel-side, so it stays `unknown` here. */
export const backlinksCommandSchema = z.looseObject({
  type: z.literal('backlinks'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  workspaceId: z.string().optional(),
  filter: z.unknown().optional(),
  ...commandIdField,
})

/** Grouped-backlinks (the grouped-references view) for a block.
 *  `filter` is as above; `grouping` is a mode string ('user' | 'none')
 *  or an explicit grouping-config object. Both coerced kernel-side. */
export const groupedBacklinksCommandSchema = z.looseObject({
  type: z.literal('grouped-backlinks'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  workspaceId: z.string().optional(),
  filter: z.unknown().optional(),
  grouping: z.unknown().optional(),
  ...commandIdField,
})

/** Print the agent-facing data-model guide. No body beyond the type. */
export const dataModelCommandSchema = z.looseObject({
  type: z.literal('data-model'),
  ...commandIdField,
})

/** Resolve a page by alias/title — exact hit plus substring candidates. */
export const pageCommandSchema = z.looseObject({
  type: z.literal('page'),
  name: z.string(),
  workspaceId: z.string().optional(),
  limit: z.number().optional(),
  ...commandIdField,
})

/** Resolve a date expression to its daily-note block. `date` accepts
 *  today | yesterday | an ISO date | the literal title ("June 17th, 2026")
 *  | natural-language ("next monday"). */
export const dailyNoteCommandSchema = z.looseObject({
  type: z.literal('daily-note'),
  date: z.string(),
  workspaceId: z.string().optional(),
  ...commandIdField,
})

/** Full-text search over block content. */
export const searchCommandSchema = z.looseObject({
  type: z.literal('search'),
  query: z.string(),
  workspaceId: z.string().optional(),
  limit: z.number().optional(),
  ...commandIdField,
})

// ----- read-only SQL guard --------------------------------------------

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
const SIDE_EFFECTING_FN = /\bpowersync_/i

/** Textual read-only enforcement, shared by every surface that accepts
 *  SQL it will run repeatedly or on someone else's authority (the km MCP
 *  graph tools, agent-dispatch watcher configs, watch-events registrations,
 *  the bridge's read-only token scope): single statement, no
 *  side-effecting function call, and either a SELECT/PRAGMA-info/EXPLAIN
 *  prologue or a WITH containing no mutating keyword — CTEs can head
 *  `WITH … UPDATE/INSERT/DELETE`, so `with` alone proves nothing. The
 *  keyword/function scan can false-positive on string literals; rewrite
 *  the query (or use the write tools) in that case. */
export const isReadOnlySql = (sql: string): boolean => {
  const body = sql.trim().replace(/;\s*$/, '')
  if (body.includes(';')) return false
  if (SIDE_EFFECTING_FN.test(body)) return false
  if (/^(select|pragma table_info|explain)\b/i.test(body)) return true
  if (/^with\b/i.test(body)) {
    return !/\b(insert|update|delete|replace|drop|alter|create|vacuum|attach|detach|reindex)\b/i.test(body)
  }
  return false
}

// ----- watch-events (push detection) ----------------------------------

/** Schema bounds, exported so consumers building registrations (e.g.
 *  the agent-dispatch daemon's config) can validate against the SAME
 *  limits — an over-cap value fails the tab's schema at registration
 *  time, where it's indistinguishable from an old bundle. */
export const WATCH_EVENTS_MAX_SETTLE_MS = 600_000
export const WATCH_EVENTS_MAX_TABLES = 8

const watcherSettleMsField = {
  /** Quiet window: the result set must be stable this long before an
   *  event is emitted (restarted on every further change). */
  settleMs: z.number().int().min(0).max(WATCH_EVENTS_MAX_SETTLE_MS).optional(),
}

/** Watch an arbitrary read-only query: the tab re-runs it on changes to
 *  `tables` and emits when the result set settles on a new value. */
export const watchEventsSqlWatcherSchema = z.looseObject({
  kind: z.literal('sql'),
  name: z.string().min(1),
  sql: z.string().refine(isReadOnlySql, {
    message: 'watcher sql must be a single read-only statement (SELECT / PRAGMA table_info / EXPLAIN, or a non-mutating WITH)',
  }),
  params: z.array(z.unknown()).optional(),
  /** Tables whose changes re-run the query (default: blocks). */
  tables: z.array(z.string().min(1)).max(WATCH_EVENTS_MAX_TABLES).optional(),
  ...watcherSettleMsField,
})

/** Watch the backlinks of one block/page — the tab owns the query shape
 *  so consumers don't hand-roll reference-table SQL. */
export const watchEventsBacklinksWatcherSchema = z.looseObject({
  kind: z.literal('backlinks'),
  name: z.string().min(1),
  targetId: z.string().min(1),
  ...watcherSettleMsField,
})

export const watchEventsWatcherSchema = z.discriminatedUnion('kind', [
  watchEventsSqlWatcherSchema,
  watchEventsBacklinksWatcherSchema,
])
export type WatchEventsWatcher = z.infer<typeof watchEventsWatcherSchema>

/** Replace `consumer`'s whole watcher registration (empty = unregister).
 *  Registrations live in the tab: they die with it and expire after
 *  `ttlMs` without a refresh, so consumers re-send this periodically. */
export const watchEventsCommandSchema = z.looseObject({
  type: z.literal('watch-events'),
  consumer: z.string().min(1),
  watchers: z.array(watchEventsWatcherSchema).max(64)
    // Names key the consumer's exemption pools — duplicates would merge
    // two watchers' settle semantics under one name.
    .refine(
      watchers => new Set(watchers.map(watcher => watcher.name)).size === watchers.length,
      {message: 'watcher names must be unique within a registration'},
    ),
  ttlMs: z.number().int().min(1_000).max(24 * 3_600_000).optional(),
  ...commandIdField,
})

/** One event as stored/delivered by the bridge's events channel. */
export interface BridgeEventRecord {
  seq: number
  receivedAt: number
  clientId: string
  event: Record<string, unknown>
}

/** GET /runtime/events/next response. `reset` marks a stale consumer
 *  cursor (bridge restarted): adopt `nextSeq` and assume missed events. */
export interface EventsNextResponse {
  events: BridgeEventRecord[]
  nextSeq: number
  reset?: boolean
}

/** Canonical commands the CLI emits. The 1:1 mapping to kmagent
 *  verbs makes this the right type for CLI construction sites. */
export const knownCommandSchema = z.discriminatedUnion('type', [
  pingCommandSchema,
  runtimeSummaryCommandSchema,
  healthCommandSchema,
  describeRuntimeCommandSchema,
  sqlCommandSchema,
  getBlockCommandSchema,
  getSubtreeCommandSchema,
  createBlockCommandSchema,
  reconcileMarkdownSubtreeCommandSchema,
  updateBlockCommandSchema,
  moveBlockCommandSchema,
  deleteBlockCommandSchema,
  restoreBlockCommandSchema,
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
  watchEventsCommandSchema,
])

/** Strict shape for any known wire command. CLI authors construct
 *  these; the kernel narrows on `.type` in its dispatch switch. */
export type KnownCommand = z.infer<typeof knownCommandSchema>

/** The literal string union of every known wire command type. */
export type KnownCommandType = KnownCommand['type']

/** Full set of commands the kernel handles — canonical + legacy
 *  aliases (`set-extension-enabled`, `action`). Used by the bridge
 *  to validate incoming commands and by the kernel's executeCommand
 *  switch for exhaustive narrowing. */
export const knownAgentCommandSchema = z.discriminatedUnion('type', [
  pingCommandSchema,
  runtimeSummaryCommandSchema,
  healthCommandSchema,
  describeRuntimeCommandSchema,
  sqlCommandSchema,
  getBlockCommandSchema,
  getSubtreeCommandSchema,
  createBlockCommandSchema,
  reconcileMarkdownSubtreeCommandSchema,
  updateBlockCommandSchema,
  moveBlockCommandSchema,
  deleteBlockCommandSchema,
  restoreBlockCommandSchema,
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
  watchEventsCommandSchema,
])
export type KnownAgentCommand = z.infer<typeof knownAgentCommandSchema>

// ---------- Command catalog (schema-derived) ----------
//
// Single source of truth for "what wire commands exist" — co-located
// with the schemas they describe. The kernel's `describe-runtime`
// output, the CLI's --help, and any future surface (in-app palette,
// AI agent prompt, README cheatsheet, etc.) all read from this
// registry so the documented shape and the wire shape never drift.

export interface KnownCommandMeta {
  /** CLI usage example, including positional + flag hints. Phrased as
   *  the user would type it via the published bin (`kmagent X`); the
   *  monorepo `pnpm agent X` wrapper invokes the same binary. */
  usage: string
  /** Short one-line description for help / summary surfaces. */
  description: string
  /** Whether a `read-only`-scoped token may run this verb — i.e. the
   *  verb performs no writes through the kernel. The bridge derives its
   *  read-only allowlist from this single field (see `isReadOnlyCommand`
   *  in `server.ts`), so the registry is the one source of truth: a verb
   *  added to `knownCommandSchema` without a registry entry is already a
   *  TypeScript error, and that entry must now classify `readOnly` too —
   *  the allowlist can't silently drift when a verb is added.
   *
   *  `sql` is the one verb whose read-only-ness depends on the call (mode
   *  + statement), not just the verb; it's `false` here and refined
   *  per-mode by the bridge before this field is consulted. */
  readOnly: boolean
}

/** Schema-derived registry of every known wire command. Typed as
 *  `Record<KnownCommandType, …>` so adding a variant to
 *  `knownCommandSchema` without a registry entry is a TypeScript
 *  error — the two sources of truth stay structurally in sync.
 *
 *  Consumers should reach for `getCommandMeta(type)` when they want a
 *  specific entry, or iterate over the registry's entries (e.g. to
 *  build a CLI help list, a runtime-summary hint set, or a README
 *  cheatsheet). */
export const knownCommandRegistry: Record<KnownCommandType, KnownCommandMeta> = {
  'ping': {
    usage: 'kmagent ping',
    description: 'Ping the bridge + runtime; print a status summary.',
    readOnly: true,
  },
  'runtime-summary': {
    usage: 'kmagent runtime-summary',
    description: 'Compact agent-oriented runtime context.',
    readOnly: true,
  },
  'health': {
    usage: 'kmagent health',
    description: 'Layout B sync-health snapshot: app-visible block count vs blocks_synced, distinct blocks queued for upload, and the materialization backlog. One read to triage a stuck or unsynced client (healthy = both queues 0 and blocks ≈ blocks_synced).',
    readOnly: true,
  },
  'describe-runtime': {
    usage: 'kmagent describe-runtime [--actions <text>] [--facets <text>] [--guide <id>] [--modules <text>] [--components <text>] [--storage]',
    description: 'Show full or targeted runtime diagnostics. Canonical "what is registered" view — prefer over reaching into facetRuntime/Repo internals via eval. When --guide is passed alone, defaults to brief output; pass --full to include actions/facets/modules/components too.',
    readOnly: true,
  },
  'sql': {
    usage: 'kmagent sql <all|get|optional|execute> <sql> [paramsJson] [--allow-synced-write]',
    description: 'Run SQL (mode: all|get|optional|execute). Refuses a raw write to a synced table (blocks, workspaces, workspace_members) — it would bypass repo.tx, so it never uploads and skips the kernel derivations (block_types, reference normalization, property projection). Use create-block/update-block/run-action for a normal write; pass --allow-synced-write for a deliberate surgical fix.',
    // Mode-dependent: `execute` (or a mutating statement) writes. The
    // bridge refines this per-call before consulting the registry, so
    // the verb-level default here is the conservative `false`.
    readOnly: false,
  },
  'get-block': {
    usage: 'kmagent get-block <id>',
    description: 'Fetch a block by id.',
    readOnly: true,
  },
  'get-subtree': {
    usage: 'kmagent subtree <rootId> [--json]',
    description: 'Fetch the subtree rooted at <rootId> (root included). Prints a depth-indented `- [id] content` outline by default (one line per block, id first); --json returns the raw flat array (each row carries its depth from the root). Both are a pre-order traversal with siblings in (order_key, id) order — already sorted; read top-to-bottom, do not re-sort.',
    readOnly: true,
  },
  'create-block': {
    usage: 'kmagent create-block <json>',
    description: 'Create a block (body shape per <json>).',
    readOnly: false,
  },
  'reconcile-markdown-subtree': {
    usage: 'kmagent reconcile-markdown-subtree <json:{parentId,markdown,key,shape?,final?,properties?}>',
    description: 'Reconcile a keyed block subtree under parentId to match markdown (parsed with the app paste parser), in one transaction — create/update/reorder/delete to converge. Idempotent by key, so a re-send lands the same tree. shape=block keeps it one block; properties tag every block. Streaming calls this repeatedly with the growing text; the last passes final:true.',
    readOnly: false,
  },
  'update-block': {
    usage: 'kmagent update-block <json>',
    description: 'Update a block (body shape per <json>).',
    readOnly: false,
  },
  'move-block': {
    usage: 'kmagent move-block <json>',
    description: 'Move a block to a new parent/position. Body: {id|blockId, parentId:string|null, position:{kind:first|last|before|after, siblingId?}}.',
    readOnly: false,
  },
  'delete-block': {
    usage: 'kmagent delete-block <id>',
    description: 'Soft-delete a block and its descendants via core.delete.',
    readOnly: false,
  },
  'restore-block': {
    usage: 'kmagent restore-block <id>',
    description: 'Restore one soft-deleted block via core.restore. Descendants remain deleted unless restored separately.',
    readOnly: false,
  },
  'install-extension': {
    usage: 'kmagent install-extension [--verify] [--description <text>] <file> [label]',
    description: 'Install a JS extension. Reload is automatic; --verify reports the contributed facets/actions; label defaults to the filename without ext.',
    readOnly: false,
  },
  'enable-extension': {
    usage: 'kmagent enable-extension <id|label>',
    description: 'Enable an installed extension by id or label. Sets the synced enabled intent AND approves the current source on this device (pins its hash) so it runs here. Re-run after editing the source to re-pin the new version.',
    readOnly: false,
  },
  'disable-extension': {
    usage: 'kmagent disable-extension <id|label>',
    description: 'Disable an installed extension by id or label (clears the synced intent; the device trust grant persists for a frictionless re-enable).',
    readOnly: false,
  },
  'uninstall-extension': {
    usage: 'kmagent uninstall-extension <id|label>',
    description: 'Uninstall an extension by id or label (deletes the block and revokes this device’s trust grant).',
    readOnly: false,
  },
  'run-action': {
    usage: 'kmagent run-action <id> [depsJson]',
    description: 'Run a registered action by id.',
    // Actions are arbitrary handlers — assume they write.
    readOnly: false,
  },
  'eval': {
    usage: 'kmagent eval [--raw] [--file <path>] [--data <path> | --data-json <json>] <code>',
    description: 'Run JS in the app. Use "return …" to print a value. The code runs with `repo`, `db`, `runtime`, `sql`, `block`, `getBlock`, `getSubtree`, `createBlock`, `updateBlock`, `moveBlock`, `deleteBlock`, `restoreBlock`, `installExtension`, `setExtensionEnabled`, `uninstallExtension`, `actions`, `renderers`, `refreshAppRuntime`, `React`, `ReactDOM`, `window`, `document` already in scope. `--data <path>` reads JSON from a file (or `--data-json <inline>` for an inline payload) and binds the parsed value as `data` — avoids template-embedding structured input in the code string.',
    // Arbitrary code execution — never read-only.
    readOnly: false,
  },
  // backlinks / grouped-backlinks resolve the user's backlinks prefs
  // sub-block (`--filter effective`, and grouped-backlinks' default
  // `--grouping user`). That sub-block is eagerly bootstrapped at idle on
  // every client via `pluginPrefsExtension` (src/data/pluginStateExtensions.ts),
  // so on the warm/live client the bridge talks to it already exists and
  // the resolve path is a pure read. (The only write either could ever do
  // is the same one-time, benign prefs-block creation the app itself does
  // at idle, were it somehow invoked before that bootstrap ran.)
  'backlinks': {
    usage: "kmagent backlinks <blockId> [--filter none|stored|effective|<json>] [--workspace <id>]",
    description: 'Hydrated backlinks of a block (blocks whose references point at it). --filter defaults to none. See `kmagent data-model`.',
    readOnly: true,
  },
  'grouped-backlinks': {
    usage: "kmagent grouped-backlinks <blockId> [--filter none|stored|effective|<json>] [--grouping user|none|<json>] [--workspace <id>]",
    description: 'The grouped-references view for a block: hydrated groups (+ Other fallback). --grouping defaults to the user config (matches the UI); --filter defaults to none. See `kmagent data-model`.',
    readOnly: true,
  },
  'data-model': {
    usage: 'kmagent data-model',
    description: "Print the agent-facing data-model guide (blocks, references, pages/daily-notes, backlinks vs grouped-backlinks, source_field, done-status, deep-links). Read this first when working with a user's data.",
    readOnly: true,
  },
  'page': {
    usage: 'kmagent page <name> [--limit <n>] [--workspace <id>]',
    description: 'Resolve a page by alias/title: exact match plus substring candidates, hydrated.',
    readOnly: true,
  },
  'daily-note': {
    usage: 'kmagent daily-note <date> [--workspace <id>]',
    description: 'Resolve a date (today | yesterday | 2026-06-18 | "June 17th, 2026" | "next monday") to its daily-note block (deterministic id; reports whether it exists yet).',
    // Pure read: computes the deterministic daily-note id and loads it,
    // reporting existence. It does NOT create the note.
    readOnly: true,
  },
  'search': {
    usage: 'kmagent search <query> [--limit <n>] [--workspace <id>]',
    description: 'Full-text search over block content; hydrated results.',
    readOnly: true,
  },
  'watch-events': {
    usage: 'kmagent raw \'{"type":"watch-events","consumer":"...","watchers":[...]}\'',
    description: "Replace a consumer's change-watcher registration in the tab; matching changes are pushed to the bridge events channel (GET /runtime/events/next).",
    // Registers observers and emits events — mutates tab state, so a
    // read-only token may not install them.
    readOnly: false,
  },
}

/** Lookup helper for surfaces that want a single command's metadata.
 *  Type-safe — TypeScript guarantees every `KnownCommandType` resolves. */
export const getCommandMeta = (type: KnownCommandType): KnownCommandMeta =>
  knownCommandRegistry[type]

export const commandStatusSchema = z.enum(['pending', 'delivered', 'completed', 'failed'])
export type CommandStatus = z.infer<typeof commandStatusSchema>

/**
 * What the kernel returns inside a command result envelope. The
 * `value` (on ok) and `error.message` (on failure) are the only
 * fields the CLI reads directly; everything else stays opaque.
 */
export const commandResultSchema = z
  .object({
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z
      .object({
        name: z.string().optional(),
        message: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .nullable()
export type CommandResult = z.infer<typeof commandResultSchema>

/** Shape returned by GET /runtime/commands/<id> — slice of the
 *  internal CommandRecord visible over the wire. */
export const commandStatusResponseSchema = z.object({
  id: z.string(),
  status: commandStatusSchema,
  result: commandResultSchema,
  clientId: z.string().nullable(),
  targetClientId: z.string(),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
  completedAt: z.number().nullable(),
})
export type CommandStatusResponse = z.infer<typeof commandStatusResponseSchema>

// ---------- /runtime/whoami response ----------

export const whoamiInfoSchema = z.object({
  clientId: z.string(),
  audience: tokenAudienceSchema,
  scope: tokenScopeSchema,
  connected: z.boolean(),
  clientLastSeen: z.number().nullable(),
})
export type WhoamiInfo = z.infer<typeof whoamiInfoSchema>

// ---------- POST /runtime/clients/<id> body ----------

/**
 * One entry of `metadata.tokens` — the client lists each token it
 * authorizes here. Only `token` is structurally required; the rest are
 * optional. `scope` is validated downstream by `tokenScope(...)` so a
 * misspelling falls back to 'read-write' rather than rejecting the
 * whole client registration.
 */
export const registerTokenSpecSchema = z
  .looseObject({
    token: z.string().min(1),
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    label: z.string().optional(),
    scope: z.string().optional(),
  })
export type RegisterTokenSpec = z.infer<typeof registerTokenSpecSchema>

export const registerClientMetadataSchema = z.looseObject({
  // Per-entry validation in the server skips malformed tokens
  // individually, so we accept any array contents here and let
  // `registerTokenSpecSchema.safeParse` do the work per entry.
  tokens: z.array(z.unknown()).optional(),
  audience: z
    .looseObject({
      userId: z.string().optional(),
      workspaceId: z.string().optional(),
    })
    .optional(),
})
export type RegisterClientMetadata = z.infer<typeof registerClientMetadataSchema>
