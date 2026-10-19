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
import { SEALED_COLUMNS, type WireBlockColumns } from '../transform.js'

/** The columns the conversion reads from a server `blocks` row. */
export interface ServerBlockRow extends WireBlockColumns {
  readonly updated_at: number
}

/** A `blocks_history` row, as much of it as the verify reads. Each diff holds
 *  only the columns that UPDATE changed. */
export interface ServerHistoryRow {
  readonly event_id: number
  readonly block_id: string
  readonly op: 'I' | 'U' | 'D'
  readonly before_diff: Readonly<Record<string, unknown>> | null
  readonly after_diff: Readonly<Record<string, unknown>> | null
}

/** One `apply_block_patches` element: the three content columns, sealed, and
 *  the row version they were sealed against. */
export interface ResealPatch {
  readonly id: string
  readonly content: string
  readonly properties_json: string
  readonly references_json: string
  readonly base_updated_at: number
}

export interface ServerWorkspace {
  readonly encryption_mode: 'none' | 'e2ee'
  readonly wk_canary: string | null
}

export interface ConversionServer {
  /** Null when this session can't see the workspace: signed out, or not a member. */
  readWorkspace(workspaceId: string): Promise<ServerWorkspace | null>
  /** How many rows the workspace holds, soft-deleted ones included. */
  countBlocks(workspaceId: string): Promise<number>
  /** The workspace's rows with an id above `afterId`, in id order, soft-deleted
   *  ones included. A page may hold fewer than `limit` rows before the end (the
   *  API caps rows per response); only an empty page means there are no more. */
  readBlockPage(workspaceId: string, afterId: string | null, limit: number): Promise<readonly ServerBlockRow[]>
  readBlocks(workspaceId: string, ids: readonly string[]): Promise<readonly ServerBlockRow[]>
  /** The UPDATE history of these blocks that wrote an envelope into `content`
   *  and changed all three content columns, each block's rows in `event_id`
   *  order. A superset of the re-seal records; the caller picks them out. */
  readContentSealHistory(workspaceId: string, blockIds: readonly string[]): Promise<readonly ServerHistoryRow[]>
  /** One `apply_block_patches` call: one transaction, all or nothing. */
  applyBlockPatches(patches: readonly ResealPatch[]): Promise<void>
}

const BLOCK_COLUMNS = 'id,workspace_id,content,properties_json,references_json,updated_at'
const HISTORY_COLUMNS = 'event_id,block_id,op,before_diff,after_diff'
/** Ids per `in.(…)` filter. They ride in the request line, which the API
 *  gateway caps at about 8 KB. */
const IDS_PER_FILTER = 100
const HISTORY_PAGE = 500

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/** Carries the PostgREST `code` and the HTTP `status` (a sibling of the error in
 *  the response, never on it), which are what tell a permanent failure from a
 *  transient one (`classifyUploadError`). */
const failed = (what: string, error: {code?: string; message: string}, status: number): Error =>
  Object.assign(
    new Error(`conversion: ${what} failed (${error.code || status}): ${error.message}`, {cause: error}),
    {code: error.code, status},
  )

export const createSupabaseConversionServer = (client: SupabaseClient): ConversionServer => ({
  async readWorkspace(workspaceId) {
    const {data, error, status} = await client
      .from('workspaces')
      .select('encryption_mode,wk_canary')
      .eq('id', workspaceId)
      .maybeSingle()
    if (error) throw failed('reading the workspace', error, status)
    return data
  },

  async countBlocks(workspaceId) {
    const {count, error, status} = await client
      .from('blocks')
      .select('id', {count: 'exact', head: true})
      .eq('workspace_id', workspaceId)
    if (error) throw failed('counting blocks', error, status)
    if (count === null) throw new Error('conversion: counting blocks returned no count')
    return count
  },

  async readBlockPage(workspaceId, afterId, limit) {
    let query = client.from('blocks').select(BLOCK_COLUMNS).eq('workspace_id', workspaceId)
    if (afterId !== null) query = query.gt('id', afterId)
    const {data, error, status} = await query.order('id', {ascending: true}).limit(limit)
    if (error) throw failed('reading blocks', error, status)
    return data
  },

  async readBlocks(workspaceId, ids) {
    const rows: ServerBlockRow[] = []
    for (const idChunk of chunk(ids, IDS_PER_FILTER)) {
      const {data, error, status} = await client
        .from('blocks')
        .select(BLOCK_COLUMNS)
        .eq('workspace_id', workspaceId)
        .in('id', idChunk)
      if (error) throw failed('reading blocks', error, status)
      rows.push(...data)
    }
    return rows
  },

  async readContentSealHistory(workspaceId, blockIds) {
    const rows: ServerHistoryRow[] = []
    for (const idChunk of chunk(blockIds, IDS_PER_FILTER)) {
      for (let afterEventId = 0; ;) {
        const {data, error, status} = await client
          .from('blocks_history')
          .select(HISTORY_COLUMNS)
          .eq('workspace_id', workspaceId)
          .in('block_id', idChunk)
          .eq('op', 'U')
          .contains('changed_columns', [...SEALED_COLUMNS])
          .like('after_diff->>content', 'enc:v1:%')
          .gt('event_id', afterEventId)
          .order('event_id', {ascending: true})
          .limit(HISTORY_PAGE)
        if (error) throw failed('reading block history', error, status)
        if (data.length === 0) break
        rows.push(...data)
        afterEventId = data[data.length - 1].event_id
      }
    }
    return rows
  },

  async applyBlockPatches(patches) {
    const {error, status} = await client.rpc('apply_block_patches', {patches})
    if (error) throw failed('apply_block_patches', error, status)
  },
})
