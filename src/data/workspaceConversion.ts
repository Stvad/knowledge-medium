/**
 * What a device reads about an in-place plaintext → E2EE conversion
 * (docs/workspace-e2ee-conversion.md §6.1–§6.2); the vocabulary is in
 * `sync/keys/conversionState.ts`.
 *
 * Read over PostgREST, not from the synced copy: the mode, canary and owner from
 * `workspaces`, and the phase from `workspace_conversions` (never synced), which
 * holds a row only while a conversion is in progress. It is embedded through
 * its `workspace_id` → `workspaces.id` foreign key.
 */

import { supabase } from '@/services/supabase'
import { ENVELOPE_PREFIX } from '@/sync/crypto/envelope.js'
import type {
  ConversionPhase,
  WorkspaceConversionRead,
} from '@/sync/keys/conversionState.js'

/** A value this build doesn't know is read as `sealing`, the phase that refuses
 *  every unlock and pin upgrade. */
export const parseConversionPhase = (raw: unknown): ConversionPhase | null => {
  if (raw === null || raw === undefined) return null
  return raw === 'cleaning' ? 'cleaning' : 'sealing'
}

/** PostgREST's "no relationship between `workspaces` and
 *  `workspace_conversions`": a server that predates the conversion migration, so
 *  no conversion can be running on it. Only this code: any other error (a broken
 *  policy naming a missing relation included) is unavailable, never "none". */
const NO_CONVERSIONS_RELATIONSHIP = 'PGRST200'

const DEFAULT_TIMEOUT_MS = 10_000

const WORKSPACE_COLUMNS = 'encryption_mode, wk_canary, owner_user_id'

interface ServerWorkspaceRow {
  encryption_mode: string
  wk_canary: string | null
  owner_user_id: string
  /** The embedded `workspace_conversions` row: an object, an array of one, or
   *  null/empty when no conversion is running. */
  workspace_conversions?: {phase: unknown} | Array<{phase: unknown}> | null
}

const requireSupabase = () => {
  if (!supabase) throw new Error('Supabase is not configured')
  return supabase
}

const embeddedPhase = (row: ServerWorkspaceRow): ConversionPhase | null => {
  const embedded = row.workspace_conversions
  const conversion = Array.isArray(embedded) ? embedded[0] : embedded
  return parseConversionPhase(conversion?.phase)
}

export const fetchWorkspaceConversionState = async (
  workspaceId: string,
  {timeoutMs = DEFAULT_TIMEOUT_MS}: {timeoutMs?: number} = {},
): Promise<WorkspaceConversionRead> => {
  const signal = AbortSignal.timeout(timeoutMs)
  const select = (columns: string) => requireSupabase()
    .from('workspaces')
    .select(columns)
    .eq('id', workspaceId)
    .abortSignal(signal)
    .maybeSingle<ServerWorkspaceRow>()
  try {
    // ONE statement, so the mode and the phase come from one snapshot: two
    // requests may each land on a different one (a read replica), pairing a
    // post-flip "e2ee" with a pre-flip "no conversion".
    let result = await select(`${WORKSPACE_COLUMNS}, workspace_conversions(phase)`)
    let conversionsExist = true
    if ((result.error as {code?: string} | null)?.code === NO_CONVERSIONS_RELATIONSHIP) {
      conversionsExist = false
      result = await select(WORKSPACE_COLUMNS)
    }
    if (result.error) return {kind: 'unavailable', error: result.error}
    if (!result.data) return {kind: 'not-visible'}
    const row = result.data
    return {
      kind: 'read',
      state: {
        encryptionMode: row.encryption_mode,
        conversionPhase: conversionsExist ? embeddedPhase(row) : null,
        wkCanary: row.wk_canary,
        ownerUserId: row.owner_user_id,
      },
    }
  } catch (error) {
    return {kind: 'unavailable', error}
  }
}

/**
 * Whether this device's `blocks` already hold ciphertext for the workspace: an
 * older build, pinned plaintext, ran across the conversion and copied re-sealed
 * rows straight through. Such a device is sent to the gated reset rather than
 * repaired in place, which would write every row again into `row_events`.
 *
 * Only the two JSON columns are checked: a plaintext row's are always `{…}` and
 * `[…]`, so an envelope there can only be copied ciphertext, whereas `content`
 * is user text that may legitimately start with the prefix.
 */
export const hasCopiedCiphertext = async (
  db: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>},
  workspaceId: string,
): Promise<boolean> => {
  const hit = await db.getOptional<{found: number}>(
    `SELECT 1 AS found FROM blocks
     WHERE workspace_id = ?
       AND (substr(properties_json, 1, ?) = ? OR substr(references_json, 1, ?) = ?)
     LIMIT 1`,
    [workspaceId, ENVELOPE_PREFIX.length, ENVELOPE_PREFIX, ENVELOPE_PREFIX.length, ENVELOPE_PREFIX],
  )
  return hit !== null
}
