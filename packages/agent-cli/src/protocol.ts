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

/** The distinctive first sentence of {@link unknownTokenMessage}. The CLI
 *  matches on THIS rather than the whole string so it can enrich a 401 the
 *  bridge produced, without the two copies having to stay byte-identical
 *  across versions (an older bridge may still be running). */
export const UNKNOWN_TOKEN_MARKER = 'Agent token is not registered with the local bridge.'

/** What the bridge can see when no connected tab lists a token. Names no
 *  user: the 401 it feeds needs no bridge secret, unlike /health's client
 *  listing. */
export interface UnknownTokenFacts {
  connectedTabs: number
  /** Where the user whose tab last listed this token stands: no tab has
   *  listed it since the bridge started, or a connected tab is / no connected
   *  tab is signed in as that user. */
  tokenUser: 'unseen' | 'connected' | 'not-connected'
}

/** What the bridge returns for a token no connected tab lists. States what
 *  the bridge can see rather than guessing at a cause. Built here, not in the
 *  server, because the CLI appends the half only IT can know — which profiles
 *  are actually paired on this machine. */
export const unknownTokenMessage = ({connectedTabs, tokenUser}: UnknownTokenFacts): string => {
  if (connectedTabs === 0) {
    return `${UNKNOWN_TOKEN_MARKER} No app tab is connected to it: open the app in the browser profile and at the app address this token was minted in.`
  }
  const tabs = `${connectedTabs} app ${connectedTabs === 1 ? 'tab is' : 'tabs are'} connected.`
  const user = {
    unseen: 'No tab has listed this token since the bridge started.',
    connected: "A connected tab is signed in as this token's user but does not list it. A tab lists the "
      + 'tokens stored in its own browser profile at its own app address, minus revoked ones; a tab '
      + "running an app version older than this bridge lists only its open workspace's (reload it).",
    'not-connected': "No connected tab is signed in as this token's user.",
  }[tokenUser]
  return `${UNKNOWN_TOKEN_MARKER} ${tabs} ${user}`
}

export const tokenScopeSchema = z.enum(['read-write', 'read-only'])
export type TokenScope = z.infer<typeof tokenScopeSchema>

/** Who a tab is signed in as and which workspace it has open. On a token
 *  (`TokenAudience`), `workspaceId` is the open workspace of the tab a call
 *  naming no workspace goes to — the default, not a limit: a token reaches
 *  every workspace of its user. */
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
 * Wire envelope for every command body POSTed to /runtime/commands: only
 * the `type` discriminator is mandatory, and the other keys pass through to
 * the kernel handler. Deliberately loose so an unknown command still
 * reaches the kernel, which produces a clearer error than a wire-level
 * rejection would; the strict per-verb shapes are `knownCommandSchema`.
 */
export const commandPayloadSchema = z.looseObject({
  type: z.string(),
})
export type CommandPayload = z.infer<typeof commandPayloadSchema>

/** The workspace a command names — its `workspaceId`, or a root create-block's
 *  `data.workspaceId` — which the bridge routes it to a tab for, and which a
 *  pinned client leaves alone. */
export const namedWorkspaceId = (payload: object): string | null => {
  const named = (value: unknown) => typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  const {workspaceId, data} = payload as {workspaceId?: unknown, data?: {workspaceId?: unknown} | null}
  return named(workspaceId) ?? named(data?.workspaceId)
}

// ---------- Known command discriminated union ----------
//
// Each branch below pins the body shape for a specific kernel handler, so
// `runCommand(cmd: KnownCommand)` type-checks CLI construction sites and
// `executeCommand(cmd: KnownAgentCommand)` narrows inside the kernel's
// dispatch switch. The bridge still validates the wire with the loose
// `commandPayloadSchema` above, so an unknown `kmagent raw` command is
// forwarded rather than rejected.
//
// `commandId` is appended by the bridge when forwarding, so it's
// optional on every variant — CLI callers don't set it; the kernel
// always sees it.

const commandIdField = {commandId: z.string().optional()}
/** Explicit attribution for write commands. `undefined` means unconfigured;
 * `null` is an intentional unattributed write. */
const contributorField = {contributorId: z.string().nullable().optional()}

/** Write verbs' id fields (`id`, `parentId`, `position.siblingId`) are already
 *  stored ids: used exactly, never read as a ref. km-mcp sends it after it has
 *  resolved them for its write guard, so the two cannot diverge; it is also
 *  the one lossless way to name an odd stored id. */
const exactIdsField = {exactIds: z.boolean().optional()}

// Variants are `looseObject` so the kernel's field-access fallbacks (e.g.
// `command.id ?? command.actionId`) keep working through the narrowing:
// declared fields are still type-checked, extras flow through as `unknown`.

export const pingCommandSchema = z.looseObject({
  type: z.literal('ping'),
  ...contributorField,
  ...commandIdField,
})

export const runtimeSummaryCommandSchema = z.looseObject({
  type: z.literal('runtime-summary'),
  ...contributorField,
  ...commandIdField,
})

export const healthCommandSchema = z.looseObject({
  type: z.literal('health'),
  ...contributorField,
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
  ...contributorField,
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
  /** Bound an `all` read for an agent: return `{rows, truncated,
   *  truncatedCells}` with at most this many rows (a SELECT stops at the
   *  bound) and every string cell cut to a fixed length (marked). Unset
   *  returns the bare row array. */
  maxRows: z.number().int().positive().optional(),
  ...contributorField,
  ...commandIdField,
})

export const getBlockCommandSchema = z.looseObject({
  type: z.literal('get-block'),
  // Either id or blockId — the kernel handler accepts both. Keeping
  // both optional + a refine at the union level would break
  // discriminatedUnion, so we leave the constraint to runtime.
  id: z.string().optional(),
  blockId: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

export const getSubtreeCommandSchema = z.looseObject({
  type: z.literal('get-subtree'),
  rootId: z.string(),
  ...contributorField,
  ...commandIdField,
})

export const createBlockCommandSchema = z.looseObject({
  type: z.literal('create-block'),
  // Absent or null: a top-level block, as move-block takes it.
  parentId: z.string().nullable().optional(),
  // position, content, properties forwarded verbatim (looseObject).
  ...contributorField,
  ...commandIdField,
})

export const createContributorCommandSchema = z.looseObject({
  type: z.literal('create-contributor'),
  name: z.string(),
  kind: z.enum(['human', 'agent', 'automation']).optional(),
  role: z.string().optional(),
  workspaceId: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

export const listContributorsCommandSchema = z.looseObject({
  type: z.literal('list-contributors'),
  workspaceId: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})
export type CreateContributorCommand = z.infer<typeof createContributorCommandSchema>
export type ListContributorsCommand = z.infer<typeof listContributorsCommandSchema>

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
 *  block — the dispatch daemon uses it to tag `agent:reply`. Streaming a
 *  reply calls this repeatedly with the growing text (same key); the last
 *  call passes `final: true`. */
export const reconcileMarkdownSubtreeCommandSchema = z.looseObject({
  type: z.literal('reconcile-markdown-subtree'),
  parentId: z.string(),
  markdown: z.string(),
  key: z.string(),
  shape: z.enum(['outline', 'block']).optional(),
  final: z.boolean().optional(),
  ...contributorField,
  ...commandIdField,
})

export const updateBlockCommandSchema = z.looseObject({
  type: z.literal('update-block'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  content: z.string().optional(),
  replaceProperties: z.boolean().optional(),
  /** Compare-and-set: refuse the whole update unless the block's content is
   *  still exactly this — what the caller read before deciding to write. */
  expectedContent: z.string().optional(),
  // properties forwarded verbatim (looseObject).
  ...exactIdsField,
  ...contributorField,
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
  ...exactIdsField,
  ...contributorField,
  ...commandIdField,
})

/** How a bounded answer comes back: the read views and append-markdown. */
const formatField = {
  format: z.enum(['text', 'json']).optional().describe(
    'text (default): compact markdown-ish rendering. json: the same bounded view, structured.',
  ),
}

/** Parse markdown with the app paste parser and insert it under a target, in
 *  one transaction. `target` is a block id / id prefix, a `[[Page]]` or a date
 *  expression (a missing page or daily note is created). `position` places the
 *  inserted run among the target's children (default last). */
export const appendMarkdownCommandSchema = z.looseObject({
  type: z.literal('append-markdown'),
  target: z.string(),
  markdown: z.string(),
  position: moveBlockPositionSchema.optional(),
  shape: z.enum(['outline', 'block']).optional(),
  ...formatField,
  ...exactIdsField,
  ...contributorField,
  ...commandIdField,
})

/** Replace the one occurrence of `old` in a block's content with `new`,
 *  against the content current inside the writing transaction. */
export const editBlockCommandSchema = z.looseObject({
  type: z.literal('edit-block'),
  id: z.string(),
  old: z.string(),
  new: z.string(),
  ...exactIdsField,
  ...contributorField,
  ...commandIdField,
})

/** Start a comment thread on a block: on `quote` (text of the block, the
 *  `occurrence`th appearance when it appears more than once), or on the
 *  whole block. No `content` makes a highlight, a thread with no comments. */
export const addCommentCommandSchema = z.looseObject({
  type: z.literal('add-comment'),
  target: z.string().describe('The block to comment on: a full id or a printed ^shortid'),
  quote: z.string().optional().describe(
    'Text of the block to anchor to, verbatim as get_block returns its content (outline views collapse '
    + 'whitespace); omit to comment on the whole block. A quote that cuts a [[link]] or ((ref)) is widened '
    + 'to the whole of it',
  ),
  occurrence: z.number().int().positive().optional().describe(
    'Which appearance of the quote in that content, from 1; required when it appears more than once. '
    + 'The result\'s quoteStart and excerpt show which one was anchored',
  ),
  content: z.string().optional().describe('The first comment; omit for a highlight with no comments'),
  ...exactIdsField,
  ...contributorField,
  ...commandIdField,
})

/** Get-or-create a page by `name` (as a `[[name]]` wikilink would), or a daily
 *  note by `date` expression. Exactly one of the two. */
export const createPageCommandSchema = z.looseObject({
  type: z.literal('create-page'),
  name: z.string().optional(),
  date: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

/** Recent local transactions of the active workspace, newest first, with the
 *  blocks each changed. Agent-bridge writes only unless `includeUser`.
 *  `since` is epoch ms or an ISO timestamp. */
export const recentChangesCommandSchema = z.looseObject({
  type: z.literal('recent-changes'),
  since: z.union([z.number(), z.string()]).optional(),
  limit: z.number().int().positive().optional(),
  includeUser: z.boolean().optional(),
  ...contributorField,
  ...commandIdField,
})

/** The full id an id-typed field resolves to (`^short`, `((id))`, a unique
 *  prefix) — what a write verb would act on. A ref matching nothing comes back
 *  as the id its syntax names (`^x` / `((x))` → `x`), else as given. Lets a
 *  caller check the same block the write will touch. */
export const resolveBlockIdCommandSchema = z.looseObject({
  type: z.literal('resolve-block-id'),
  ref: z.string(),
  ...contributorField,
  ...commandIdField,
})

/** One block's recorded changes, newest first — local and sync-applied. */
export const blockHistoryCommandSchema = z.looseObject({
  type: z.literal('block-history'),
  id: z.string().describe('The block: a full id or a unique id prefix as printed (^3f2a9c1d)'),
  limit: z.number().int().positive().optional().describe('Max events (default 20, at most 100)'),
  ...contributorField,
  ...commandIdField,
})

export const deleteBlockCommandSchema = z.looseObject({
  type: z.literal('delete-block'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  ...exactIdsField,
  ...contributorField,
  ...commandIdField,
})

export const restoreBlockCommandSchema = z.looseObject({
  type: z.literal('restore-block'),
  id: z.string().optional(),
  blockId: z.string().optional(),
  ...exactIdsField,
  ...contributorField,
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
  allowPresetChange: z.boolean().optional(),
  ...contributorField,
  ...commandIdField,
})

export const enableExtensionCommandSchema = z.looseObject({
  type: z.literal('enable-extension'),
  id: z.string().optional(),
  label: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

export const disableExtensionCommandSchema = z.looseObject({
  type: z.literal('disable-extension'),
  id: z.string().optional(),
  label: z.string().optional(),
  ...contributorField,
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
  ...contributorField,
  ...commandIdField,
})

export const uninstallExtensionCommandSchema = z.looseObject({
  type: z.literal('uninstall-extension'),
  id: z.string().optional(),
  label: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

export const auditExtensionCommandSchema = z.looseObject({
  type: z.literal('audit-extension'),
  id: z.string().optional(),
  label: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

export const auditPropertiesCommandSchema = z.looseObject({
  type: z.literal('audit-properties'),
  workspaceId: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

export const runBackfillCommandSchema = z.looseObject({
  type: z.literal('run-backfill'),
  backfillId: z.string(),
  workspaceId: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

export const rematerializeWorkspaceCommandSchema = z.looseObject({
  type: z.literal('rematerialize-workspace'),
  workspaceId: z.string().optional(),
  /** `'unapplied' | 'all'`; validated kernel-side so an unknown value comes
   *  back as a named refusal rather than a schema rejection with no advice. */
  scope: z.string().optional(),
  ...contributorField,
  ...commandIdField,
})

export const runActionCommandSchema = z.looseObject({
  type: z.literal('run-action'),
  id: z.string(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  ...contributorField,
  ...commandIdField,
})

/** Legacy alias — the kernel handles `'action'` the same way as
 *  `'run-action'`. Kept in the union so the kernel switch can match
 *  it after narrowing. */
export const actionCommandSchema = z.looseObject({
  type: z.literal('action'),
  id: z.string(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  ...contributorField,
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
  ...contributorField,
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
  ...contributorField,
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
  ...contributorField,
  ...commandIdField,
})

/** The data-model guide's topic ids in its reading order. The app's guide
 *  tags each of its sections with one, and a test holds the two lists equal. */
export const DATA_MODEL_TOPICS = [
  'blocks', 'pages', 'daily-notes', 'references', 'grouped-backlinks', 'block-kinds', 'properties', 'queries', 'writing',
  'comments', 'sql',
] as const
export type DataModelTopic = typeof DATA_MODEL_TOPICS[number]

/** The agent-facing data-model guide: an index, one topic, or all of it. */
export const dataModelCommandSchema = z.looseObject({
  type: z.literal('data-model'),
  topic: z.string().optional().describe(
    'A topic id from the index to read that section, or "all" for the whole guide. Omit for the index.',
  ),
  ...contributorField,
  ...commandIdField,
})

const readWorkspaceField = z.string().optional().describe(
  'Workspace to read. Defaults to the one open in the app tab; the token reaches every workspace of its user.',
)

/** Resolve a page by alias/title — exact hit plus substring candidates. */
export const pageCommandSchema = z.looseObject({
  type: z.literal('page'),
  name: z.string().describe('Page name or alias to resolve'),
  workspaceId: readWorkspaceField,
  limit: z.number().int().positive().optional().describe('Max substring candidates (default 20)'),
  ...contributorField,
  ...commandIdField,
})

/** Resolve a date expression to its daily-note block. `date` accepts
 *  today | yesterday | an ISO date | the literal title ("June 17th, 2026")
 *  | natural-language ("next monday"). */
export const dailyNoteCommandSchema = z.looseObject({
  type: z.literal('daily-note'),
  date: z.string().describe('today, yesterday, an ISO date (2026-06-18), or natural language (next monday)'),
  workspaceId: readWorkspaceField,
  ...contributorField,
  ...commandIdField,
})

/** Full-text search over block content. */
export const searchCommandSchema = z.looseObject({
  type: z.literal('search'),
  query: z.string(),
  workspaceId: z.string().optional(),
  limit: z.number().int().positive().optional(),
  ...contributorField,
  ...commandIdField,
})

// ---------- Agent views ----------
//
// `view-*` commands are the agent-facing reads: bounded (default limits,
// truncated content with a char count, an explicit continuation), with
// context per hit (breadcrumb, decoded properties, child counts), rendered
// app-side where the property registry can decode values. The raw commands
// above (`get-block`, `get-subtree`, `backlinks`, …) keep their stored,
// unbounded shapes for programmatic consumers.
//
// These schemas double as the MCP tool input schemas and the CLI option
// lists (packages/agent-cli/src/readTools.ts), so every `.describe()` here
// is user-facing help text.

/** Defaults the app applies when a view field is omitted. Named here so the
 *  help text and the app agree on one number. */
export const AGENT_VIEW_DEFAULTS = {
  searchLimit: 10,
  backlinksLimit: 20,
  groupsLimit: 10,
  membersPerGroup: 3,
  outlineLimit: 100,
  outlineDepth: 3,
  blockMaxChars: 4000,
  sqlMaxRows: 200,
  /** An outline line's content budget; longer content is cut with a marker. */
  lineChars: 200,
  /** What an outline's root and rows print, in characters (the unit Claude
   *  Code's over-the-cap notice reports): for ordinary text well under its MCP
   *  cap (25k tokens), and under the CLI's 30k-character shell cap with room for
   *  the legend lines, which are not counted. Accepted, not guaranteed: the
   *  first row is kept past it, so a page always advances; `format: 'json'`
   *  prints the same rows several times larger; and text dense in tokens per
   *  character reaches the MCP cap sooner. */
  outlineChars: 24_000,
  commentsLimit: 20,
} as const

const viewRefField = z.string().describe(
  'The block: a full id, a unique id prefix as printed (^3f2a9c1d), a page name '
  + '(or [[Page name]]), or a date for its daily note (today, yesterday, 2026-06-18).',
)

const viewFields = {
  // A view decodes values through the open workspace's registries, so naming
  // a workspace routes the call rather than widening what one tab reads.
  workspaceId: z.string().optional().describe(
    'Workspace to read. The call goes to an app tab that has it open (default: the most recently '
    + 'focused tab), and is refused when no connected tab does.',
  ),
  ...formatField,
}

const viewLimitField = (what: string, defaultValue: number) =>
  z.number().int().positive().optional().describe(`Max ${what} (default ${defaultValue})`)

const viewOffsetField = (what: string) =>
  z.number().int().nonnegative().optional().describe(`Skip the first N ${what} (to continue a truncated listing)`)

const backlinksFilterField = z
  .union([z.enum(['none', 'stored', 'effective']), z.record(z.string(), z.unknown())])
  .optional()
  .describe("none (default) | stored (the block's saved filter) | effective (what the UI applies) | {include?, exclude?}")

export const viewBlockCommandSchema = z.looseObject({
  type: z.literal('view-block'),
  ref: viewRefField,
  maxChars: z.number().int().positive().optional().describe(
    `Max content characters to return (default ${AGENT_VIEW_DEFAULTS.blockMaxChars})`,
  ),
  contentOffset: z.number().int().nonnegative().optional().describe(
    'Start the content at this character (to read past a truncation)',
  ),
  ...viewFields,
  ...contributorField,
  ...commandIdField,
})

export const viewOutlineCommandSchema = z.looseObject({
  type: z.literal('view-outline'),
  ref: viewRefField,
  depth: z.number().int().positive().optional().describe(
    `Levels below the root to expand (default ${AGENT_VIEW_DEFAULTS.outlineDepth})`,
  ),
  limit: viewLimitField('blocks shown below the root; shallower levels are filled first', AGENT_VIEW_DEFAULTS.outlineLimit),
  offset: viewOffsetField("of the root's children"),
  properties: z.enum(['brief', 'none', 'full']).optional().describe(
    'Properties per line: brief (default; the first few, compactly), none, or full',
  ),
  expandCollapsed: z.boolean().optional().describe(
    'Expand blocks below the root that the user collapsed (default: summarized as +N children)',
  ),
  ...viewFields,
  ...contributorField,
  ...commandIdField,
})

export const viewBacklinksCommandSchema = z.looseObject({
  type: z.literal('view-backlinks'),
  ref: viewRefField,
  limit: viewLimitField('backlinks', AGENT_VIEW_DEFAULTS.backlinksLimit),
  offset: viewOffsetField('backlinks'),
  filter: backlinksFilterField,
  ...viewFields,
  ...contributorField,
  ...commandIdField,
})

export const viewGroupedBacklinksCommandSchema = z.looseObject({
  type: z.literal('view-grouped-backlinks'),
  ref: viewRefField,
  limit: viewLimitField('groups', AGENT_VIEW_DEFAULTS.groupsLimit),
  offset: viewOffsetField('groups'),
  membersPerGroup: viewLimitField('members shown per group', AGENT_VIEW_DEFAULTS.membersPerGroup),
  memberOffset: viewOffsetField('members of each group'),
  filter: backlinksFilterField,
  grouping: z
    .union([z.enum(['user', 'none']), z.record(z.string(), z.unknown())])
    .optional()
    .describe("user (default; the user's grouping config, as the UI shows it) | none | a grouping-config object"),
  ...viewFields,
  ...contributorField,
  ...commandIdField,
})

export const viewSearchCommandSchema = z.looseObject({
  type: z.literal('view-search'),
  query: z.string().describe('Text to find in block content. "quoted phrase", OR, and -term are supported'),
  limit: viewLimitField('results', AGENT_VIEW_DEFAULTS.searchLimit),
  offset: viewOffsetField('results'),
  types: z.array(z.string()).optional().describe('Only blocks with any of these types (type id or label, e.g. todo)'),
  under: z.string().optional().describe('Only blocks inside this block/page (same forms as a block ref)'),
  includeExtensions: z.boolean().optional().describe('Include extension source blocks (excluded by default)'),
  ...viewFields,
  ...contributorField,
  ...commandIdField,
})

/** Comment threads, each with its anchor (block, exact, moved or stale), the
 *  quoted text, an excerpt and path of its target, and its comments nested as
 *  replied, each with its author's name and kind. */
export const commentsCommandSchema = z.looseObject({
  type: z.literal('comments'),
  scope: z.string().optional().describe(
    'Threads on any block under this block or page, and threads on their comments (same forms as a block ref)',
  ),
  block: z.string().optional().describe('Threads on this one block (same forms as a block ref)'),
  thread: z.string().optional().describe("One thread, by its root's id, whatever its status"),
  includeClosed: z.boolean().optional().describe('Include resolved threads (default: open only)'),
  limit: viewLimitField('threads', AGENT_VIEW_DEFAULTS.commentsLimit),
  offset: viewOffsetField('threads'),
  workspaceId: viewFields.workspaceId,
  ...contributorField,
  ...commandIdField,
})

/** The type of a comment thread's root, which the annotations plugin owns as
 *  `annotation:thread`; a test there holds the two equal. */
export const COMMENT_THREAD_TYPE = 'annotation:thread'

/** What `comments` answers. */
export type CommentAnchorState = 'block' | 'exact' | 'moved' | 'stale'

export interface CommentAuthor {
  /** The author's page; null for a system author. */
  id: string | null
  name: string
  /** Null when the author's page is not here to say. */
  kind: 'human' | 'agent' | 'automation' | null
}

export interface CommentNode {
  id: string
  shortId: string
  content: string
  /** Characters cut from `content`; get_block reads the rest. */
  cut: number
  author: CommentAuthor
  createdAt: number
  replies: CommentNode[]
}

export interface CommentThreadView {
  id: string
  shortId: string
  /** `open` or `resolved`, or the stored value when this build can't read it. */
  status: string
  anchor: CommentAnchorState
  /** The quoted text; null for a thread on the whole block. */
  quote: string | null
  target: {
    id: string
    shortId: string
    deleted: boolean
    /** Root→parent labels, as a breadcrumb reads. */
    path: string[]
    /** The quote with some text around it, or the block's head. */
    excerpt: string
  } | null
  comments: CommentNode[]
  /** Comments past the per-thread cap, not in `comments`. */
  omittedComments: number
}

export interface CommentsView {
  total: number
  offset: number
  nextOffset: number | null
  threads: CommentThreadView[]
}

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
 *  token match is comment-proof. The app registers no other writable UDFs,
 *  so this family is the whole vector. */
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
  ...contributorField,
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
  createContributorCommandSchema,
  listContributorsCommandSchema,
  reconcileMarkdownSubtreeCommandSchema,
  updateBlockCommandSchema,
  moveBlockCommandSchema,
  deleteBlockCommandSchema,
  restoreBlockCommandSchema,
  appendMarkdownCommandSchema,
  editBlockCommandSchema,
  createPageCommandSchema,
  recentChangesCommandSchema,
  blockHistoryCommandSchema,
  resolveBlockIdCommandSchema,
  installExtensionCommandSchema,
  enableExtensionCommandSchema,
  disableExtensionCommandSchema,
  uninstallExtensionCommandSchema,
  auditExtensionCommandSchema,
  auditPropertiesCommandSchema,
  runBackfillCommandSchema,
  rematerializeWorkspaceCommandSchema,
  runActionCommandSchema,
  evalCommandSchema,
  backlinksCommandSchema,
  groupedBacklinksCommandSchema,
  dataModelCommandSchema,
  pageCommandSchema,
  dailyNoteCommandSchema,
  searchCommandSchema,
  viewBlockCommandSchema,
  viewOutlineCommandSchema,
  viewBacklinksCommandSchema,
  viewGroupedBacklinksCommandSchema,
  viewSearchCommandSchema,
  commentsCommandSchema,
  addCommentCommandSchema,
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
  createContributorCommandSchema,
  listContributorsCommandSchema,
  reconcileMarkdownSubtreeCommandSchema,
  updateBlockCommandSchema,
  moveBlockCommandSchema,
  deleteBlockCommandSchema,
  restoreBlockCommandSchema,
  appendMarkdownCommandSchema,
  editBlockCommandSchema,
  createPageCommandSchema,
  recentChangesCommandSchema,
  blockHistoryCommandSchema,
  resolveBlockIdCommandSchema,
  installExtensionCommandSchema,
  enableExtensionCommandSchema,
  disableExtensionCommandSchema,
  setExtensionEnabledCommandSchema,
  uninstallExtensionCommandSchema,
  auditExtensionCommandSchema,
  auditPropertiesCommandSchema,
  runBackfillCommandSchema,
  rematerializeWorkspaceCommandSchema,
  runActionCommandSchema,
  actionCommandSchema,
  evalCommandSchema,
  backlinksCommandSchema,
  groupedBacklinksCommandSchema,
  dataModelCommandSchema,
  pageCommandSchema,
  dailyNoteCommandSchema,
  searchCommandSchema,
  viewBlockCommandSchema,
  viewOutlineCommandSchema,
  viewBacklinksCommandSchema,
  viewGroupedBacklinksCommandSchema,
  viewSearchCommandSchema,
  commentsCommandSchema,
  addCommentCommandSchema,
  watchEventsCommandSchema,
])
export type KnownAgentCommand = z.infer<typeof knownAgentCommandSchema>

// ---------- Command catalog (schema-derived) ----------
//
// Single source of truth for "what wire commands exist", co-located with
// the schemas it describes. `describe-runtime`, the CLI's --help and any
// other surface read from this registry, so the documented shape and the
// wire shape never drift.

export interface KnownCommandMeta {
  /** CLI usage example, including positional + flag hints. Phrased as
   *  the user would type it via the published bin (`kmagent X`); the
   *  monorepo `pnpm agent X` wrapper invokes the same binary. */
  usage: string
  /** Short one-line description for help / summary surfaces. */
  description: string
  /** Whether a `read-only`-scoped token may run this verb — i.e. the verb
   *  performs no writes through the kernel. The bridge derives its
   *  read-only allowlist from this one field (`isReadOnlyCommand` in
   *  `server.ts`), so the allowlist cannot drift when a verb is added: the
   *  missing registry entry is already a TypeScript error, and the entry
   *  has to classify `readOnly`.
   *
   *  `sql` is the one verb whose read-only-ness depends on the call (mode
   *  + statement), not just the verb; it's `false` here and refined
   *  per-mode by the bridge before this field is consulted. */
  readOnly: boolean
}

/** How the write verbs name where to write: quoted by the CLI verbs and the
 *  km MCP tools alike, so both surfaces say the same thing. */
export const WRITE_TARGET_HELP =
  'A target is a block id or a printed short id (^3f2a9c1b); a [[Page name]], created if missing as typing '
  + 'that link would ([[2026-10-15]] is that daily note); or a date (today, next monday, 2026-10-15) for its '
  + 'daily note, created if missing. Bare text is tried as an id prefix, an existing page, then a date — so '
  + 'name a page as [[name]].'

/** A todo composes the built-in `todo` type. */
export const TODO_WRITE_HELP =
  'A todo is a block with properties {"types": ["todo"], "status": "open"}; set "status" to "done" to complete '
  + 'it (properties merge).'

/** Schema-derived registry of every known wire command. Typed as
 *  `Record<KnownCommandType, …>` so adding a variant to
 *  `knownCommandSchema` without a registry entry is a TypeScript error —
 *  the two sources of truth stay structurally in sync. Read a single entry
 *  with `getCommandMeta(type)`. */
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
    description: 'Sync-health snapshot, one read to triage a stuck or unsynced client. Layout B: app-visible block count vs blocks_synced, distinct blocks queued for upload, the materialization backlog, and `syncDivergence` — per workspace, downloaded rows `blocks` does not hold with nothing in flight to deliver them: `unapplied` (still flagged for the drain) and `stranded` (the drain cleared the flag but the rows differ; nothing else reports these), by kind with an example id. Remedy for both: `rematerialize-workspace --scope all` with that workspace active — but not while `rematerializing` is true (a rescan is already repairing those rows; re-read when it finishes), not under `materializability: \'defer\'` (the rescan defers them again until the workspace key or mode resolves), and not for `local-newer`, usually an upload whose echo has not arrived, which the rescan would temporarily revert. Rows a rescan leaves unapplied are counted in its `deferred` / `quarantined` totals. Any `materializability` but `copy` means the workspace was checked on its clear columns only. Healthy = both queues 0, blocks ≈ blocks_synced, syncDivergence empty.',
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
    usage: 'kmagent get-block <ref> --raw',
    description: 'Fetch a block as stored (raw BlockData). The agent view is `view-block`.',
    readOnly: true,
  },
  'get-subtree': {
    usage: 'kmagent subtree <ref> --raw',
    description: 'Fetch the WHOLE subtree rooted at <ref> (root included) as the raw flat array, each row carrying its depth from the root — unbounded, for programmatic use (the agent view is `view-outline`). A pre-order traversal with siblings in (order_key, id) order — already sorted; read top-to-bottom, do not re-sort.',
    readOnly: true,
  },
  'create-block': {
    usage: 'kmagent create-block <json>',
    description: 'Create one block. Body: {parentId, content, properties?, position?: first|last}; parentId is a target '
      + `as for append-markdown, or null for a top-level block (not a page — use create-page). ${TODO_WRITE_HELP}`,
    readOnly: false,
  },
  'create-contributor': {
    usage: 'kmagent contributor create <name> [--kind human|agent|automation] [--role <text>]',
    description: 'Create a page-backed contributor record in the active workspace.',
    readOnly: false,
  },
  'list-contributors': {
    usage: 'kmagent contributor list [--workspace <id>]',
    description: 'List page-backed contributors in a workspace.',
    readOnly: true,
  },
  'reconcile-markdown-subtree': {
    usage: 'kmagent reconcile-markdown-subtree <json:{parentId,markdown,key,shape?,final?,properties?}>',
    description: 'Reconcile a keyed block subtree under parentId to match markdown (parsed with the app paste parser), in one transaction — create/update/reorder/delete to converge. Idempotent by key, so a re-send lands the same tree. shape=block keeps it one block; properties tag every block. Streaming calls this repeatedly with the growing text; the last passes final:true.',
    readOnly: false,
  },
  'update-block': {
    usage: 'kmagent update-block <json>',
    description: 'Update a block. Body: {id, content?, properties?, replaceProperties?, expectedContent?}. Properties merge '
      + 'unless replaceProperties. With expectedContent the update is refused, showing the current content, unless '
      + 'the block\'s content is exactly that (read it whole with get-block, not from an outline line). id may be a '
      + 'unique id prefix.',
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
  'append-markdown': {
    usage: "kmagent append-markdown <target> [--first | --after <id> | --before <id>] [--one-block] -- '<markdown>'   (or pipe it on stdin)",
    description: 'Insert markdown under <target> in ONE transaction, split into blocks as the app\'s paste does; '
      + `prints the new blocks (the first ${AGENT_VIEW_DEFAULTS.outlineLimit}). ${WRITE_TARGET_HELP} With --after/--before the anchor must be a child of the target. `
      + 'Markdown goes after `--` (it usually starts with "- ") or on stdin.',
    readOnly: false,
  },
  'edit-block': {
    usage: "kmagent edit-block <id> <old> <new>   (or: kmagent edit-block <id> -- '<old>' '<new>' when either starts with -)",
    description: 'Replace the one occurrence of <old> in a block\'s content with <new> (literal text), against its '
      + 'content at write time; prints the change in context. Refused when <old> is empty or found more than once '
      + '(add surrounding text), and when it is not found, showing the current content. <id> may be a unique id prefix.',
    readOnly: false,
  },
  'create-page': {
    usage: "kmagent create-page <name> | --date <expr>   (a name starting with - goes after --: kmagent create-page -- '-Inbox')",
    description: 'Get-or-create a page by name, as typing [[name]] would, or a daily note with --date <expr>. Reports '
      + 'whether it was created.',
    readOnly: false,
  },
  'recent-changes': {
    usage: 'kmagent recent-changes [--since <ms|iso>] [--limit <n>] [--all]',
    description: 'Recent agent-bridge writes in this workspace, newest first. Each lists the blocks it changed (content '
      + 'before/after, clipped); --all adds the user\'s own edits here. eval, sql '
      + 'execute and run-action writes are not attributed.',
    readOnly: true,
  },
  'block-history': {
    usage: 'kmagent block-history <id> [--limit <n>]',
    description: 'One block\'s recorded changes, newest first, local and synced, with content before/after (cut past '
      + '2,000 chars) — to review a change. A content ending in a cut marker is not whole, so do not write it back.',
    readOnly: true,
  },
  'resolve-block-id': {
    usage: 'kmagent raw \'{"type":"resolve-block-id","ref":"^3f2a9c1b"}\'',
    description: 'The full block id an id-typed write field resolves to (^short, ((id)), unique prefix) — never a name or date. A ref that matches nothing comes back as the id its syntax names (^x, ((x)) → x), else as given. km-mcp uses it so its write guard checks the block the write will touch.',
    readOnly: true,
  },
  'install-extension': {
    usage: 'kmagent install-extension [--verify] [--allow-preset-change] [--description <text>] <file> [label]',
    description: 'Install a JS extension. Reload is automatic; `running` in the result is approved AND enabled on this device, not proof the source loaded — an install that makes the source live also executes it and reports load errors unasked, one onto a block that is not live runs nothing; --verify reports the contributed facets/actions; label defaults to the filename without ext. REFUSES when the install would change which codec a value preset id resolves to here — a core building a different codec than the one live under that id, or an update dropping an id it currently registers (the id then falls back to whatever was underneath) — that re-types every value stored under it with no row edit to migrate from, so nothing downstream repairs it; the refusal names what moved and the definitions and cell counts at stake. That check EXECUTES the source, so it runs only when this install makes the source live — the block passes BOTH gates here, approved AND enabled — or when --verify asks for it. An install onto a block that is new, not approved here, or DISABLED stores source nothing runs and is not checked: pass --verify to check one anyway, and note that enabling it later is not covered. --allow-preset-change installs anyway and reports what it changed.',
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
  'audit-extension': {
    usage: 'kmagent audit-extension <id|label>',
    description: 'Audit the DATA an installed extension wrote, against the grain the app rewards. It flags block ids parked in non-ref properties (invisible to backlinks), records buried in a JSON cell, properties written with no registered schema (the fingerprint of a write made while the extension was not running), and declared types no block carries. Complements the install-time source lint, which can only read declarations. Also reports whether the extension is approved / enabled / actually running here.',
    readOnly: true,
  },
  'audit-properties': {
    usage: 'kmagent audit-properties [--workspace <id>]',
    description: 'List every property key in the workspace\'s live blocks that the registry does NOT resolve. Property migration skips those keys silently (propertyChildrenProcessor: no schema → `continue`), so they are the only property data a child-backed workspace cannot carry. Per key: exact cell count, the resolver\'s own reason (nothing declares it, or a definition block exists but is broken), the fix in the order §9 requires, plus sampled blocks and the types they carry (which extension wrote it). Audits the ACTIVE workspace; it refuses one whose registry is not loaded rather than reporting every key as unregistered. Reports its own basis — `syncGap` (staged rows the drain would actually apply — narrower than `agent health`\'s raw staging count, which also counts this device\'s own upload echoes — or the sync layer not settled: downloading, disconnected, or a download error — so the counts are short) and `syncedThrough` (this device\'s last completed sync); an empty list under a non-null `syncGap` means nothing, and a null `syncGap` only rules out work outstanding LOCALLY. Past the flip it also reports `coverage`: registered cells with no live field row, which a cell-only write leaves while every key still registers — `missing` (what re-running the properties migration writes; zero means nothing left to repair), `refused` (the codec rejects the value; repair it first) and `deletedThroughChildren` (the field row is tombstoned; the migration leaves these). `coverage` is null before the flip. Does NOT detect shadowed definitions or seed-name collisions — those still resolve, so no key is listed. Workspace-wide counterpart to `audit-extension`, which only sees blocks carrying one extension\'s declared types.',
    readOnly: true,
  },
  'run-backfill': {
    usage: 'kmagent run-backfill <backfillId> [--workspace <id>] [--wait <seconds>]',
    description: 'Run one operator-triggered workspace backfill. Currently `properties:cell-to-children`, the properties-as-blocks migration: every registered property cell gains the field and value CHILD blocks it implies, cells untouched. Deliberately not scheduled — the pass uploads source-of-truth rows, so ONE device runs it and every other receives them; a completion claim in synced data records that. Returns `outcome` — the runner\'s own result code; see `OperatorBackfillResult` in src/data/repo.ts for the current set and what each means, rather than a copy here that can drift — plus `undoHistoryCleared`: the pass drops the workspace undo stack whenever it writes, because replaying an entry recorded before it would revert the migration. Refuses to write (outcome `deferred`) while this device is behind the server or still draining synced rows; retry once sync settles. Safe to re-run: it is idempotent per row and resumes from whatever is left to do, so an interrupted run needs no repair.',
    readOnly: false,
  },
  'rematerialize-workspace': {
    usage: 'kmagent rematerialize-workspace [--workspace <id>] [--scope unapplied|all] [--wait <seconds>]',
    description: 'Re-run the sync drain over rows this device downloaded but never applied. It is the remedy for the durable materialization gap every one-way pass refuses on ("N synced row(s) of this workspace have not reached `blocks` on this device"). Those rows reached the drain, were not applied (workspace not unlocked, mode unresolved, a key-store read that failed, ciphertext that would not decode, or a speculative stamp-0 mint the seed could not vouch for), and had their queue entry consumed — so nothing re-delivers them and waiting never clears them. A DERIVATION pass over LOCAL state: it rebuilds this device\'s `blocks` from rows this device already downloaded, uploads nothing, needs no per-graph claim, does not clear the undo stack, and is safe to run on any device any number of times. `--scope unapplied` (default) re-delivers exactly the rows the refusal counts; `--scope all` re-judges every staged row of the workspace, which is what to use when the flag itself is suspect, at the cost of a full pass. Returns the exact `unappliedBefore`/`unappliedAfter` gap sizes plus the pass\'s own counts and `remainingGap` — the predicate re-asked. A pass that leaves rows unapplied has not failed: its `deferred` / `quarantined` counts say why. Neither is fixed by re-running ALONE — `deferred` needs the workspace materializable first (unlock it, or a key store that reads: a transient key-store failure defers too, and that one a re-run does fix), `quarantined` needs bytes that decode. `reflagged` is the count going the other way — at `--scope all`, a workspace that answers `defer` re-flags rows an earlier drain had cleared, so that scope CAN leave the gap larger (at `--scope unapplied` it is always 0, since every row in that set is flagged already). Two more things to know before running it: prefer a settled sync, because a re-pass can briefly write an older staged row over a local edit that is acked but not yet echoed back (the echo re-asserts it, so it self-heals unless the tab closes inside that window); and the pass occupies this device\'s materialization queue for its whole run, so no synced row reaches `blocks` until it finishes — seconds at `unapplied`, minutes at `all` on a large graph.',
    // Writes the local `blocks` table (never `blocks_synced`, never an upload).
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
  // backlinks / grouped-backlinks read the user's prefs with `readPluginPref`,
  // which creates nothing: both are pure reads.
  'backlinks': {
    usage: "kmagent backlinks <ref> --raw [--filter none|stored|effective|<json>]",
    description: 'Every backlink of a block (blocks whose references point at it), hydrated, unbounded — for programmatic use (the agent view is `view-backlinks`). --filter defaults to none. See `kmagent data-model`.',
    readOnly: true,
  },
  'grouped-backlinks': {
    usage: "kmagent grouped-backlinks <ref> --raw [--filter none|stored|effective|<json>] [--grouping user|none|<json>]",
    description: 'The grouped-references view for a block, every group and member hydrated (+ Other fallback) — unbounded (the agent view is `view-grouped-backlinks`). --grouping defaults to the user config (matches the UI); --filter defaults to none. See `kmagent data-model`.',
    readOnly: true,
  },
  'data-model': {
    usage: 'kmagent data-model [<topic id>|all]',
    description: `The agent-facing data-model guide; read it first when working with a user's data. A short index by default, one section by topic id (${DATA_MODEL_TOPICS.join(', ')}), everything with topic all.`,
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
    usage: 'kmagent raw \'{"type":"search","query":"<query>","limit":<n>,"workspaceId":"<id>"}\'',
    description: 'Full-text search over block content; whole hydrated rows (the agent view is `view-search`).',
    readOnly: true,
  },
  // The views read what the raw commands above read, so they classify the same.
  'view-block': {
    usage: 'kmagent get-block <ref> [--max-chars <n>] [--content-offset <n>] [--json]',
    description: 'One block, for reading: its content (truncated past maxChars, with how to continue), breadcrumb, types, decoded properties, child and backlink counts.',
    readOnly: true,
  },
  'view-outline': {
    usage: 'kmagent subtree <ref> [--depth <n>] [--limit <n>] [--offset <n>] [--properties brief|none|full] [--expand-collapsed] [--json]',
    description: `A block and its descendants as a markdown outline: \`- content  key:: value  ^shortid\`, one line per block. Bounded: expands \`depth\` levels and at most \`limit\` blocks below the root, shallower levels first, and stops early, saying how to narrow, at ${AGENT_VIEW_DEFAULTS.outlineChars} characters; unexpanded children show as \`(+N children)\`, long content as \`…[+N chars]\`, and a cut-off list of the root's children ends with the offset to continue from.`,
    readOnly: true,
  },
  'view-backlinks': {
    usage: 'kmagent backlinks <ref> [--limit <n>] [--offset <n>] [--filter none|stored|effective|<json>] [--json]',
    description: 'Blocks that reference this block or page, a page at a time. Each comes with its breadcrumb (page › parent …) and how it references the target; a block that is only a link also shows its parent\'s text and first child.',
    readOnly: true,
  },
  'view-grouped-backlinks': {
    usage: 'kmagent grouped-backlinks <ref> [--limit <n>] [--offset <n>] [--members-per-group <n>] [--filter …] [--grouping user|none|<json>] [--json]',
    description: 'Backlinks grouped by the pages/blocks they appear in context of (the grouped-references panel): each group with its size and its first few members.',
    readOnly: true,
  },
  'view-search': {
    usage: 'kmagent search <query> [--limit <n>] [--offset <n>] [--types <type>…] [--under <ref>] [--include-extensions] [--json]',
    description: 'Full-text search over block content. Each hit: a snippet around the match, its breadcrumb and types; identical blocks are folded into one hit. Extension source is excluded unless asked for.',
    readOnly: true,
  },
  'comments': {
    usage: 'kmagent comments (--scope <ref> | --block <ref> | --thread <id>) [--include-closed] [--limit <n>] [--offset <n>]',
    description: 'Comment threads of a scope, a block, or one thread. As JSON: with --scope, those on any block under '
      + 'it and, recursively, on their comments. Each has its status; its anchor (block for a whole-block thread, else exact, moved or '
      + 'stale against the target as it reads now); the quote; the target\'s id, path and an excerpt; and its comments '
      + 'nested as replied (the first 50 per thread; omittedComments counts the rest), each with its author\'s name and '
      + 'kind (human, agent or automation). A page ends early past the views\' size budget. Open threads only unless '
      + '--include-closed. Reply with append-markdown under the comment being answered; resolve or reopen with '
      + 'update-block on the root\'s annotation:status (open | resolved). See `kmagent data-model comments`.',
    readOnly: true,
  },
  'add-comment': {
    usage: "kmagent add-comment '<json>'   ({target, quote?, occurrence?, content?})",
    description: 'Start a comment thread on a block. It anchors to quoted text of the block, or to the whole block, '
      + 'and returns the thread\'s root id (write ((id)) to quote that range elsewhere). The quote is found in the block\'s current text, and '
      + 'refused when absent, or when it appears more than once without occurrence. A quote that cuts a [[link]] or '
      + '((ref)) is widened to the whole of it. No content makes a highlight. Refuses property field and value rows.',
    readOnly: false,
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

/** Shared by token authorization and contributor admission. Unknown verbs write. */
export const isReadOnlyAgentCommand = (command: {type: string; mode?: unknown; sql?: unknown}): boolean => {
  if (command.type === 'sql') {
    return command.mode !== 'execute' && typeof command.sql === 'string' && isReadOnlySql(command.sql)
  }
  return (knownCommandRegistry as Partial<Record<string, KnownCommandMeta>>)[command.type]?.readOnly === true
}

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
  /** When the tab last had focus (ms); a call naming no workspace goes to
   *  the user's most recently focused tab. Null when it never has. */
  focusedAt: z.number().nullable().optional(),
})
export type RegisterClientMetadata = z.infer<typeof registerClientMetadataSchema>

// ---------- Agent-facing display text ----------

/**
 * The characters treated as hostile in agent-facing DISPLAY text (outline
 * content, rendered properties, view snippets): all of C0 except TAB, DEL,
 * all of C1, U+2028/U+2029, and every codepoint the Unicode `Bidi_Control`
 * property covers. Ids are not prose and get a different, lossless
 * treatment where they are printed (subtreeOutline.ts `encodeOutlineId`).
 *
 * INVARIANT: no character that can forge a line break or REORDER displayed
 * text reaches the terminal (or an LLM reading the raw text) through
 * display text.
 *
 * The bidi class ("Trojan Source": an override or isolate inside content is
 * rendered unchanged by a bidi-aware terminal, which can visually reorder
 * an id token and its delimiter without a single byte moving) is
 * matched as a Unicode PROPERTY rather than a hand-enumerated transcription
 * of its members, because a transcription can silently omit a member
 * exactly as reordering-capable as the rest. The C0/C1/DEL/line-separator
 * half stays a hand-enumerated range only because no single Unicode
 * property matches this TAB-excluded, Zl/Zp-inclusive boundary.
 *
 * TAB (U+0009) is the one deliberate exclusion: a terminal advances the
 * cursor FORWARD on TAB, so unlike the rest it can never walk back over
 * already-printed text, and no parser here reads it as a line break.
 *
 * ZERO WIDTH JOINER (U+200D) and ZERO WIDTH NON-JOINER (U+200C) are
 * deliberately NOT neutralized, so do not broaden this to `\p{Cf}` or
 * `\p{C}`: neither reorders anything (they shape adjacent characters in
 * place) and both are required in real content — compound emoji are built
 * with ZWJ, and ZWNJ is mandatory orthography in Persian, Hindi and other
 * scripts. Accepted residual: an invisible but NON-reordering character can
 * still reach rendered prose, which is display fidelity rather than the
 * anti-forgery concern defended here.
 */
// eslint-disable-next-line no-control-regex -- intentional control-char match
const CONTROL_CHAR_RUN_REGEX = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]+/gu

/** Collapse each run of hostile characters (see
 *  {@link CONTROL_CHAR_RUN_REGEX}) to one ` ⏎ ` marker — lossy, which is
 *  acceptable for prose and never for an identifier. Lives here because both
 *  sides of the bridge render agent-facing text: the CLI's outline and the
 *  app's agent views. */
export const neutralizeDisplayText = (text: string): string =>
  text.replace(CONTROL_CHAR_RUN_REGEX, ' ⏎ ')

/** What `JSON.stringify` leaves raw of that class — DEL, C1 controls, the
 *  line/paragraph separators, bidi controls (it escapes the rest of C0). */
const UNESCAPED_JSON_DISPLAY_CONTROL = /[\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/gu

/** `\u`-escape what `JSON.stringify` leaves raw of the display-forging class.
 *  Lossless — unlike {@link neutralizeDisplayText} — and only valid on JSON
 *  text, where these characters occur only inside string literals and the
 *  escape denotes the same string. */
const escapeJsonDisplayControls = (json: string): string =>
  json.replace(UNESCAPED_JSON_DISPLAY_CONTROL, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** A value as agent-facing JSON: pretty-printed and display-safe, losslessly. */
export const toDisplayJson = (value: unknown): string => {
  const json = JSON.stringify(value, null, 2) as string | undefined
  return json === undefined ? String(value) : escapeJsonDisplayControls(json)
}

/** The page name in a `[[Name]]` write target — what a missing page is created
 *  under, and so its content — or null when `text` is not one. */
export const pageNameInTarget = (text: string): string | null => {
  const match = /^\s*\[\[([\s\S]*)\]\]\s*$/.exec(text)
  return match ? match[1].trim() : null
}

/** The page `create-page <name>` gets or creates: one outer `[[…]]` is the
 *  name's wrapper, and the name is trimmed. The runtime and the write guard
 *  both read a name through this. */
export const createPageName = (name: string): string => pageNameInTarget(name) ?? name.trim()

/* Cutting agent-facing text to a budget, shared by the app's read views and
 * the CLI/MCP renderers so every cut reads the same. */

export const formatCount = (n: number): string => n.toLocaleString('en-US')

/** The marker a cut leaves behind: how much is missing, so an agent can tell
 *  a summary from the whole and knows a fuller read exists. */
export const cutMarker = (cutChars: number): string => `…[+${formatCount(cutChars)} chars]`

export interface Clipped {
  text: string
  /** Characters of the input not in `text` (0 when it fit). */
  cut: number
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** `at` moved back by one when it would split a surrogate pair, so a slice
 *  boundary there keeps an astral character (an emoji) whole on one side. */
export const charBoundary = (text: string, at: number): number =>
  at > 0 && at < text.length && isHighSurrogate(text.charCodeAt(at - 1)) ? at - 1 : at

/** Cut to at most `max` characters of the ORIGINAL text, marked. */
export const clip = (text: string, max: number): Clipped => {
  if (text.length <= max) return {text, cut: 0}
  const end = charBoundary(text, max)
  return {text: `${text.slice(0, end)}${cutMarker(text.length - end)}`, cut: text.length - end}
}
