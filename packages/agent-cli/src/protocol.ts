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
  includeRoot: z.boolean().optional(),
  ...commandIdField,
})

export const createBlockCommandSchema = z.looseObject({
  type: z.literal('create-block'),
  parentId: z.string().optional(),
  // position, content, properties forwarded verbatim (looseObject).
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
  ...commandIdField,
})

/** Canonical commands the CLI emits. The 1:1 mapping to kmagent
 *  verbs makes this the right type for CLI construction sites. */
export const knownCommandSchema = z.discriminatedUnion('type', [
  pingCommandSchema,
  runtimeSummaryCommandSchema,
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
])
export type KnownAgentCommand = z.infer<typeof knownAgentCommandSchema>

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
