/**
 * Read-only views over the local change log, so an agent session can report
 * what it changed and the user can review (and restore from) it.
 *
 *   - `recent-changes` — `command_events` (one row per local `repo.tx`) joined
 *     to the `row_events` each wrote. Agent writes are told apart by their
 *     description prefix (see `agentWrites.ts`).
 *   - `block-history` — one block's `row_events`, local and sync-applied.
 *
 * The first runtime READER of `row_events`: a change to its row format has to
 * update `snapshotOf` here.
 */
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { AGENT_TX_DESCRIPTION_PREFIX } from './agentWrites.ts'
import { shortIds } from './agentViews/resolveRef.ts'

interface RowEventRow {
  tx_id: string | null
  block_id: string
  kind: string
  before_json: string | null
  after_json: string | null
  source: string
  created_at: number
}

interface Snapshot {
  parentId: string | null
  orderKey: string
  content: string
  properties: Record<string, unknown>
  references: unknown
  deleted: boolean
}

const snapshotOf = (json: string | null): Snapshot | null => {
  if (json === null) return null
  const raw = JSON.parse(json) as Partial<Snapshot>
  return {
    parentId: raw.parentId ?? null,
    orderKey: raw.orderKey ?? '',
    content: raw.content ?? '',
    properties: raw.properties ?? {},
    references: raw.references ?? [],
    deleted: raw.deleted === true,
  }
}

export type ChangeKind = 'create' | 'update' | 'move' | 'soft-delete' | 'restore' | 'delete'
export type ChangedField = 'content' | 'parent' | 'order' | 'properties' | 'references' | 'deleted'

export interface BlockChange {
  blockId: string
  /** Unique id prefix, as the read views print it (`^short`). */
  shortId: string
  kind: ChangeKind
  /** What this write changed, compared field by field. */
  changed: ChangedField[]
  content?: {before?: string; after?: string}
  parentId?: {before: string | null; after: string | null}
  /** Property names whose stored value differs. */
  properties?: string[]
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const changedPropertyNames = (before: Snapshot, after: Snapshot): string[] =>
  [...new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])]
    .filter(name => !sameJson(before.properties[name], after.properties[name]))
    .sort()

const clip = (content: string, limit: number | undefined): string =>
  limit !== undefined && content.length > limit ? `${content.slice(0, limit)}…` : content

const describeRowEvent = (row: RowEventRow, contentLimit?: number): Omit<BlockChange, 'shortId'> => {
  const before = snapshotOf(row.before_json)
  const after = snapshotOf(row.after_json)
  if (!before || !after) {
    const only = (after ?? before)!
    return {
      blockId: row.block_id,
      kind: after ? 'create' : 'delete',
      changed: ['content'],
      content: after ? {after: clip(only.content, contentLimit)} : {before: clip(only.content, contentLimit)},
      parentId: after ? {before: null, after: only.parentId} : {before: only.parentId, after: null},
    }
  }
  const changed: ChangedField[] = []
  if (before.content !== after.content) changed.push('content')
  if (before.parentId !== after.parentId) changed.push('parent')
  if (before.orderKey !== after.orderKey) changed.push('order')
  const properties = changedPropertyNames(before, after)
  if (properties.length > 0) changed.push('properties')
  if (!sameJson(before.references, after.references)) changed.push('references')
  if (before.deleted !== after.deleted) changed.push('deleted')

  const kind: ChangeKind = before.deleted && !after.deleted ? 'restore'
    : !before.deleted && after.deleted ? 'soft-delete'
      : changed.length > 0 && changed.every(field => field === 'parent' || field === 'order') ? 'move'
        : 'update'
  return {
    blockId: row.block_id,
    kind,
    changed,
    ...(changed.includes('content') || kind === 'soft-delete' || kind === 'restore'
      ? {content: {before: clip(before.content, contentLimit), after: clip(after.content, contentLimit)}}
      : {}),
    ...(changed.includes('parent') ? {parentId: {before: before.parentId, after: after.parentId}} : {}),
    ...(properties.length > 0 ? {properties} : {}),
  }
}

const parseSince = (value: unknown): number => {
  if (value === undefined) return 0
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  throw new Error(`since must be epoch milliseconds or an ISO timestamp, got ${JSON.stringify(value)}.`)
}

const parseLimit = (value: unknown, fallback: number, max: number): number => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`limit must be a positive integer, got ${JSON.stringify(value)}.`)
  }
  return Math.min(value, max)
}

const isoAt = (ms: number): string => new Date(ms).toISOString()

export interface RecentChangesInput {
  since?: unknown
  limit?: unknown
  /** Include the user's own local edits, not only agent-bridge writes. */
  includeUser: boolean
}

export interface RecentChangeTx {
  txId: string
  at: string
  description: string | null
  changes: BlockChange[]
}

export interface RecentChangesResult {
  workspaceId: string
  since: string
  agentOnly: boolean
  /** More transactions matched than `limit` returned. */
  truncated: boolean
  /** Newest first. */
  txs: RecentChangeTx[]
}

const RECENT_CONTENT_LIMIT = 200

export const recentChanges = async (repo: Repo, input: RecentChangesInput): Promise<RecentChangesResult> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error('recent-changes: no active workspace — open one in the app and retry.')
  const since = parseSince(input.since)
  const limit = parseLimit(input.limit, 20, 200)
  // Document edits only: UI-state and preference txs are not changes to review.
  const txs = await repo.db.getAll<{tx_id: string; description: string | null; created_at: number}>(
    `SELECT tx_id, description, created_at FROM command_events
      WHERE workspace_id = ? AND scope = ? AND created_at >= ?
        ${input.includeUser ? '' : 'AND substr(description, 1, ?) = ?'}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
    [
      workspaceId, ChangeScope.BlockDefault, since,
      ...(input.includeUser ? [] : [AGENT_TX_DESCRIPTION_PREFIX.length, AGENT_TX_DESCRIPTION_PREFIX]),
      limit + 1,
    ],
  )
  const page = txs.slice(0, limit)
  const rows = await repo.db.getAll<RowEventRow>(
    `SELECT tx_id, block_id, kind, before_json, after_json, source, created_at FROM row_events
      WHERE tx_id IN (SELECT value FROM json_each(?))
      ORDER BY id`,
    [JSON.stringify(page.map(tx => tx.tx_id))],
  )
  const short = await shortIds(repo, rows.map(row => row.block_id))
  const changesByTx = new Map<string, BlockChange[]>()
  for (const row of rows) {
    const list = changesByTx.get(row.tx_id!) ?? []
    list.push({...describeRowEvent(row, RECENT_CONTENT_LIMIT), shortId: short.get(row.block_id)!})
    changesByTx.set(row.tx_id!, list)
  }
  return {
    workspaceId,
    since: isoAt(since),
    agentOnly: !input.includeUser,
    truncated: txs.length > limit,
    txs: page.map(tx => ({
      txId: tx.tx_id,
      at: isoAt(tx.created_at),
      description: tx.description,
      changes: changesByTx.get(tx.tx_id) ?? [],
    })),
  }
}

export interface BlockHistoryInput {
  id: string
  limit?: unknown
}

export interface BlockHistoryEvent extends BlockChange {
  at: string
  /** `local` — a transaction on this device; `sync` — applied from the server. */
  source: 'local' | 'sync'
  txId: string | null
  description: string | null
}

export interface BlockHistoryResult {
  blockId: string
  shortId: string
  /** Newest first, full content. */
  events: BlockHistoryEvent[]
  truncated: boolean
}

export const blockHistory = async (repo: Repo, input: BlockHistoryInput): Promise<BlockHistoryResult> => {
  const limit = parseLimit(input.limit, 20, 500)
  const rows = await repo.db.getAll<RowEventRow & {description: string | null}>(
    `SELECT r.tx_id, r.block_id, r.kind, r.before_json, r.after_json, r.source, r.created_at,
            c.description
       FROM row_events r LEFT JOIN command_events c ON c.tx_id = r.tx_id
      WHERE r.block_id = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?`,
    [input.id, limit + 1],
  )
  if (rows.length === 0) throw new Error(`block-history: no recorded changes for block ${input.id}.`)
  const shortId = (await shortIds(repo, [input.id])).get(input.id)!
  return {
    blockId: input.id,
    shortId,
    truncated: rows.length > limit,
    events: rows.slice(0, limit).map(row => ({
      at: isoAt(row.created_at),
      source: row.source === 'sync' ? 'sync' : 'local',
      txId: row.tx_id,
      description: row.description,
      ...describeRowEvent(row),
      shortId,
    })),
  }
}
