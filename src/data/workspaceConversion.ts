/**
 * What a device reads about an in-place plaintext → E2EE conversion
 * (docs/workspace-e2ee-conversion.md §6.1–§6.2); the vocabulary is in
 * `sync/keys/conversionState.ts`.
 *
 * `conversion_phase` is not synced, so it is read from the server over
 * PostgREST, together with the mode, canary and owner from the same row, so a
 * gate decides from one consistent read.
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

const UNDEFINED_COLUMN = '42703'
const DEFAULT_TIMEOUT_MS = 10_000

interface ServerWorkspaceRow {
  encryption_mode: string
  wk_canary: string | null
  conversion_phase?: unknown
  owner_user_id: string
}

const selectWorkspaceRow = (workspaceId: string, columns: string, signal: AbortSignal) => {
  if (!supabase) throw new Error('Supabase is not configured')
  return supabase
    .from('workspaces')
    .select(columns)
    .eq('id', workspaceId)
    .abortSignal(signal)
    .maybeSingle<ServerWorkspaceRow>()
}

export const fetchWorkspaceConversionState = async (
  workspaceId: string,
  {timeoutMs = DEFAULT_TIMEOUT_MS}: {timeoutMs?: number} = {},
): Promise<WorkspaceConversionRead> => {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    let result = await selectWorkspaceRow(
      workspaceId, 'encryption_mode, wk_canary, conversion_phase, owner_user_id', signal,
    )
    // A server without the column predates the conversion migration, so no
    // conversion can be running on it.
    if ((result.error as {code?: string} | null)?.code === UNDEFINED_COLUMN) {
      result = await selectWorkspaceRow(workspaceId, 'encryption_mode, wk_canary, owner_user_id', signal)
    }
    if (result.error) return {kind: 'unavailable', error: result.error}
    if (!result.data) return {kind: 'unavailable', error: new Error(`workspace ${workspaceId} not visible`)}
    const row = result.data
    return {
      kind: 'read',
      state: {
        encryptionMode: row.encryption_mode,
        conversionPhase: parseConversionPhase(row.conversion_phase),
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
