/**
 * What the in-place E2EE conversion reads from and writes to the server
 * (docs/workspace-e2ee-conversion.md §6.3). The re-seal and its verify read the
 * server directly rather than this device's PowerSync image, which stops
 * advancing while any write for the workspace is held.
 *
 * The engine depends on {@link ConversionServer}; {@link createSupabaseConversionServer}
 * is the PostgREST implementation, and tests inject an in-memory one.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { chunk } from 'lodash-es'
import { ENVELOPE_PREFIX } from '../crypto/envelope.js'
import { SEALED_COLUMNS, type WireBlockColumns } from '../transform.js'

export type ContentColumns = Pick<WireBlockColumns, (typeof SEALED_COLUMNS)[number]>

/** The columns the conversion reads from a server `blocks` row. */
export interface ServerBlockRow extends WireBlockColumns {
  readonly updated_at: number
}

/** A `blocks` row with every column the server holds, as the recovery bundle
 *  archives it. */
export type FullServerBlockRow = ServerBlockRow & Readonly<Record<string, unknown>>

/** A `blocks_history` row with every column, as the recovery bundle archives it. */
export type FullServerHistoryRow = Readonly<Record<string, unknown>> & {
  readonly event_id: number
  readonly workspace_id: string
}

/** `conversion_workspace_counts`: read in one statement, so from one snapshot. */
export interface WorkspaceCounts {
  /** Block rows, soft-deleted ones included. */
  readonly blocks: number
  /** History rows. Every write to a block adds one. */
  readonly history: number
  /** The workspace's highest `event_id`, or 0 when it has no history. */
  readonly maxEventId: number
}

/** A `blocks_history` row, as much of it as the verify reads. Each diff holds
 *  only the columns that UPDATE changed. */
export interface ServerHistoryRow {
  readonly event_id: number
  readonly block_id: string
  readonly before_diff: Readonly<Record<string, unknown>> | null
  readonly after_diff: Readonly<Record<string, unknown>> | null
}

/** One `apply_block_patches` element: the three content columns, sealed, and
 *  the row version they were sealed against. */
export interface ResealPatch extends ContentColumns {
  readonly id: string
  readonly base_updated_at: number
}

/** The SQLSTATEs the conversion RPCs refuse with (supabase migration
 *  20261019120000_add_workspace_e2ee_conversion.sql). */
export const ConversionErrorCode = {
  /** Refused: fix the state and retry. The message names the RPC and why. */
  refused: 'KMC01',
  /** The purge's recovery bundle is stale: re-take it, then purge again. */
  staleBundle: 'KMC02',
  /** The flip found block writes in flight: retry as is. */
  lockNotAvailable: '55P03',
} as const

/** The PostgREST `code` a port call failed with, if it was the server's answer. */
export const errorCodeOf = (error: unknown): string | undefined => {
  const code = (error as {code?: unknown} | null)?.code
  return typeof code === 'string' ? code : undefined
}

export interface ServerWorkspace {
  readonly encryption_mode: 'none' | 'e2ee'
  readonly wk_canary: string | null
  readonly properties_migration: string
}

export interface ConversionServer {
  /** Null when this session can't see the workspace: signed out, or not a member. */
  readWorkspace(workspaceId: string): Promise<ServerWorkspace | null>
  /** Owner-only, through one RPC: counting under the row-level policies costs a
   *  check per row and runs past the statement timeout on a large workspace. */
  workspaceCounts(workspaceId: string): Promise<WorkspaceCounts>
  /** The workspace's rows with an id above `afterId`, in id order, soft-deleted
   *  ones included. A page may hold fewer than `limit` rows before the end (the
   *  API caps rows per response); only an empty page means there are no more. */
  readBlockPage(workspaceId: string, afterId: string | null, limit: number): Promise<readonly ServerBlockRow[]>
  readBlocks(workspaceId: string, ids: readonly string[]): Promise<readonly ServerBlockRow[]>
  /** The UPDATE history of these blocks that wrote an envelope into `content`
   *  and changed all three content columns, in any order. A superset of the
   *  re-seal records; the caller picks them out. */
  readContentSealHistory(workspaceId: string, blockIds: readonly string[]): Promise<readonly ServerHistoryRow[]>
  /** One `apply_block_patches` call: one transaction, all or nothing. */
  applyBlockPatches(patches: readonly ResealPatch[]): Promise<void>
  /** `convert_workspace_to_e2ee`: the mode becomes e2ee with this canary and
   *  the `sealing` phase begins, in one transaction; no row changes. */
  convertWorkspaceToE2ee(workspaceId: string, canary: string): Promise<void>
  /** {@link readBlockPage}, with every column. */
  readFullBlockPage(workspaceId: string, afterId: string | null, limit: number): Promise<readonly FullServerBlockRow[]>
  /** The workspace's history rows with `afterEventId < event_id ≤ throughEventId`,
   *  in `event_id` order, every column. Paged like {@link readBlockPage}. */
  readHistoryPage(
    workspaceId: string,
    afterEventId: number,
    throughEventId: number,
    limit: number,
  ): Promise<readonly FullServerHistoryRow[]>
  /** `purge_workspace_history`: delete the workspace's history and move the
   *  phase to `cleaning`, if the server's checks against the bundle pass. */
  purgeWorkspaceHistory(workspaceId: string, throughEventId: number, archivedCount: number): Promise<void>
}

const BLOCK_COLUMNS = 'id,workspace_id,content,properties_json,references_json,updated_at'
const HISTORY_COLUMNS = 'event_id,block_id,before_diff,after_diff'
/** Ids per `in.(…)` filter. They ride in the request line, which the API
 *  gateway caps at about 8 KB. */
export const IDS_PER_FILTER = 100
export const HISTORY_PAGE = 500

/** Carries the PostgREST `code` and the HTTP `status` (a sibling of the error in
 *  the response, never on it), which are what tell a permanent failure from a
 *  transient one (`classifyUploadError`). */
const failed = (what: string, error: {code?: string; message: string}, status: number): Error =>
  Object.assign(
    new Error(`conversion: ${what} failed (${error.code || status}): ${error.message}`, {cause: error}),
    {code: error.code, status},
  )

/** How long the flip request may take before the run stops waiting for it
 *  and reads the server's stage instead. */
export const FLIP_REQUEST_TIMEOUT_MS = 60_000

/** `signal` cancels every read and write but the flip, which Stop never cuts:
 *  an aborted flip request may still commit, with nobody waiting. The flip has
 *  its own deadline instead, after which the run reads what the server holds. */
export const createSupabaseConversionServer = (
  client: SupabaseClient,
  signal?: AbortSignal,
  {flipTimeoutMs = FLIP_REQUEST_TIMEOUT_MS}: {flipTimeoutMs?: number} = {},
): ConversionServer => {
  const cancellable = <Q extends {abortSignal(signal: AbortSignal): Q}>(query: Q): Q =>
    signal ? query.abortSignal(signal) : query
  return {
    async readWorkspace(workspaceId) {
      const {data, error, status} = await cancellable(client
        .from('workspaces')
        .select('encryption_mode,wk_canary,properties_migration')
        .eq('id', workspaceId))
        .maybeSingle()
      if (error) throw failed('reading the workspace', error, status)
      return data
    },

    async workspaceCounts(workspaceId) {
      const {data, error, status} = await cancellable(client.rpc('conversion_workspace_counts', {p_workspace_id: workspaceId}))
      if (error) throw failed('conversion_workspace_counts', error, status)
      const [row] = data as Array<{block_count: number; history_count: number; max_event_id: number}>
      if (!row) throw new Error('conversion: conversion_workspace_counts returned no row')
      return {blocks: row.block_count, history: row.history_count, maxEventId: row.max_event_id}
    },

    async readBlockPage(workspaceId, afterId, limit) {
      let query = client.from('blocks').select(BLOCK_COLUMNS).eq('workspace_id', workspaceId)
      if (afterId !== null) query = query.gt('id', afterId)
      const {data, error, status} = await cancellable(query.order('id', {ascending: true}).limit(limit))
      if (error) throw failed('reading blocks', error, status)
      return data
    },

    async readBlocks(workspaceId, ids) {
      const rows: ServerBlockRow[] = []
      for (const idChunk of chunk(ids, IDS_PER_FILTER)) {
        const {data, error, status} = await cancellable(client
          .from('blocks')
          .select(BLOCK_COLUMNS)
          // Defence in depth: a block id is unique across workspaces.
          .eq('workspace_id', workspaceId)
          .in('id', idChunk))
        if (error) throw failed('reading blocks', error, status)
        rows.push(...data)
      }
      return rows
    },

    async readContentSealHistory(workspaceId, blockIds) {
      const rows: ServerHistoryRow[] = []
      for (const idChunk of chunk(blockIds, IDS_PER_FILTER)) {
        for (let afterEventId = 0; ;) {
          const {data, error, status} = await cancellable(client
            .from('blocks_history')
            .select(HISTORY_COLUMNS)
            // Defence in depth: a block id is unique across workspaces.
            .eq('workspace_id', workspaceId)
            .in('block_id', idChunk)
            // Defence in depth: INSERT and DELETE rows leave changed_columns
            // NULL, which the containment below already excludes.
            .eq('op', 'U')
            .contains('changed_columns', [...SEALED_COLUMNS])
            .like('after_diff->>content', `${ENVELOPE_PREFIX}%`)
            .gt('event_id', afterEventId)
            .order('event_id', {ascending: true})
            .limit(HISTORY_PAGE))
          if (error) throw failed('reading block history', error, status)
          if (data.length === 0) break
          rows.push(...data)
          afterEventId = data[data.length - 1].event_id
        }
      }
      return rows
    },

    async applyBlockPatches(patches) {
      const {error, status} = await cancellable(client.rpc('apply_block_patches', {patches}))
      if (error) throw failed('apply_block_patches', error, status)
    },

    async readFullBlockPage(workspaceId, afterId, limit) {
      let query = client.from('blocks').select('*').eq('workspace_id', workspaceId)
      if (afterId !== null) query = query.gt('id', afterId)
      const {data, error, status} = await cancellable(query.order('id', {ascending: true}).limit(limit))
      if (error) throw failed('reading blocks', error, status)
      return data as FullServerBlockRow[]
    },

    async readHistoryPage(workspaceId, afterEventId, throughEventId, limit) {
      const {data, error, status} = await cancellable(client
        .from('blocks_history')
        .select('*')
        .eq('workspace_id', workspaceId)
        .gt('event_id', afterEventId)
        .lte('event_id', throughEventId)
        .order('event_id', {ascending: true})
        .limit(limit))
      if (error) throw failed('reading block history', error, status)
      return data as FullServerHistoryRow[]
    },

    async purgeWorkspaceHistory(workspaceId, throughEventId, archivedCount) {
      const {error, status} = await cancellable(client.rpc('purge_workspace_history', {
        p_workspace_id: workspaceId,
        p_through_event_id: throughEventId,
        p_archived_count: archivedCount,
      }))
      if (error) throw failed('purge_workspace_history', error, status)
    },

    async convertWorkspaceToE2ee(workspaceId, canary) {
      const {error, status} = await client.rpc('convert_workspace_to_e2ee', {
        p_workspace_id: workspaceId,
        p_wk_canary: canary,
      }).abortSignal(AbortSignal.timeout(flipTimeoutMs))
      if (error) throw failed('convert_workspace_to_e2ee', error, status)
    },
  }
}
