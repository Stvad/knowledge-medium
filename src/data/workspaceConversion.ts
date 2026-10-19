/**
 * What a device reads about an in-place plaintext → E2EE conversion
 * (docs/workspace-e2ee-conversion.md §6.1–§6.2); the vocabulary is in
 * `sync/keys/conversionState.ts`.
 *
 * Neither read is synced: the mode, canary and owner come from `workspaces`
 * over PostgREST, and the phase from `workspace_conversions`, which holds a row
 * only while a conversion is in progress.
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

/** PostgREST's "no such table in the schema cache", and Postgres's own. A server
 *  without `workspace_conversions` predates the conversion migration, so no
 *  conversion can be running on it. */
const MISSING_TABLE_CODES: ReadonlySet<string> = new Set(['PGRST205', '42P01'])

const DEFAULT_TIMEOUT_MS = 10_000

interface ServerWorkspaceRow {
  encryption_mode: string
  wk_canary: string | null
  owner_user_id: string
}

const requireSupabase = () => {
  if (!supabase) throw new Error('Supabase is not configured')
  return supabase
}

export const fetchWorkspaceConversionState = async (
  workspaceId: string,
  {timeoutMs = DEFAULT_TIMEOUT_MS}: {timeoutMs?: number} = {},
): Promise<WorkspaceConversionRead> => {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const client = requireSupabase()
    // The workspace row FIRST: the phase only moves forward, so a phase read
    // after the mode can only be later than it. The other order could pair a
    // pre-flip "no row" with a post-flip "e2ee" and open a sealing workspace.
    const workspace = await client
      .from('workspaces')
      .select('encryption_mode, wk_canary, owner_user_id')
      .eq('id', workspaceId)
      .abortSignal(signal)
      .maybeSingle<ServerWorkspaceRow>()
    if (workspace.error) return {kind: 'unavailable', error: workspace.error}
    if (!workspace.data) return {kind: 'unavailable', error: new Error(`workspace ${workspaceId} not visible`)}

    const conversion = await client
      .from('workspace_conversions')
      .select('phase')
      .eq('workspace_id', workspaceId)
      .abortSignal(signal)
      .maybeSingle<{phase: unknown}>()
    const tableMissing = MISSING_TABLE_CODES.has((conversion.error as {code?: string} | null)?.code ?? '')
    if (conversion.error && !tableMissing) return {kind: 'unavailable', error: conversion.error}

    const row = workspace.data
    return {
      kind: 'read',
      state: {
        encryptionMode: row.encryption_mode,
        conversionPhase: tableMissing ? null : parseConversionPhase(conversion.data?.phase),
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
