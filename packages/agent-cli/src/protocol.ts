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
 */
export const commandPayloadSchema = z.looseObject({
  type: z.string(),
})
export type CommandPayload = z.infer<typeof commandPayloadSchema>

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
