/**
 * Read-only views over the local change log, so an agent session can report
 * what it changed and the user can review it.
 *
 *   - `recent-changes` — `command_events` (one row per local `repo.tx`) joined
 *     to the `row_events` each wrote. Agent writes are told apart by their
 *     description prefix (see `agentWrites.ts`).
 *   - `block-history` — one block's `row_events`, local and sync-applied.
 *
 * The first runtime READER of `row_events`: a change to its row format has to
 * update `changeColumnsSql` and `snapshotOf` here.
 */
import { ChangeScope } from '@/data/api'
import { registryRecognitionParams } from '@/data/internals/kernelQueries.js'
import { recognizedFieldRowSql } from '@/data/internals/treeQueries.js'
import type { Repo } from '@/data/repo'
import { AGENT_TX_DESCRIPTION_PREFIX } from './agentWrites.ts'
import { shortIds } from './agentViews/resolveRef.ts'
import { clampInt, viewWorkspace } from './agentViews/shared.ts'
import { cutMarker } from './agentViews/text.ts'

/** A change as the views read it: the before / after snapshots without their
 *  content, which comes as a bounded head with its full length, and whether
 *  it changed — compared in SQL, so a megabyte content is never loaded only
 *  to be cut. See {@link changeColumnsSql}. */
interface ChangeRow {
  tx_id: string | null
  block_id: string
  source: string
  created_at: number
  before_meta: string | null
  after_meta: string | null
  before_head: string | null
  before_len: number | null
  after_head: string | null
  after_len: number | null
  before_nul: number | null
  after_nul: number | null
  content_changed: number
}

/** The SELECT columns of a {@link ChangeRow} whose before snapshot is row
 *  `b`'s and after snapshot row `a`'s — one row_events row, or a block's
 *  first and last write in a tx. Binds the content head length twice. */
const changeColumnsSql = (b: string, a: string): string => `
  ${a}.tx_id AS tx_id, ${a}.block_id AS block_id, ${a}.source AS source, ${a}.created_at AS created_at,
  json_remove(${b}.before_json, '$.content') AS before_meta,
  json_remove(${a}.after_json, '$.content') AS after_meta,
  substr(json_extract(${b}.before_json, '$.content'), 1, ?) AS before_head,
  length(json_extract(${b}.before_json, '$.content')) AS before_len,
  substr(json_extract(${a}.after_json, '$.content'), 1, ?) AS after_head,
  length(json_extract(${a}.after_json, '$.content')) AS after_len,
  instr(CAST(json_extract(${b}.before_json, '$.content') AS BLOB), x'00') > 0 AS before_nul,
  instr(CAST(json_extract(${a}.after_json, '$.content') AS BLOB), x'00') > 0 AS after_nul,
  json_extract(${b}.before_json, '$.content') IS NOT json_extract(${a}.after_json, '$.content') AS content_changed`

interface Snapshot {
  parentId: string | null
  orderKey: string
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
    properties: raw.properties ?? {},
    references: raw.references ?? [],
    deleted: raw.deleted === true,
  }
}

/** A content head as shown: SQLite counted `length` and cut `head` in
 *  characters, so a cut is exactly `length - limit` of them. Both stop at a
 *  NUL character, so a content holding one is shown up to it and marked. */
const shownContent = (head: string | null, length: number | null, nul: number | null, limit: number): string => {
  if (head === null) return ''
  if (nul) return `${head}…[cut at a NUL character]`
  return length !== null && length > limit ? `${head}${cutMarker(length - limit)}` : head
}

type ChangeKind = 'create' | 'update' | 'move' | 'soft-delete' | 'restore' | 'delete'
type ChangedField = 'content' | 'parent' | 'order' | 'properties' | 'references' | 'deleted'

interface BlockChange {
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

const describeChange = (row: ChangeRow, contentLimit: number): Omit<BlockChange, 'shortId'> => {
  const before = snapshotOf(row.before_meta)
  const after = snapshotOf(row.after_meta)
  const content = {
    before: shownContent(row.before_head, row.before_len, row.before_nul, contentLimit),
    after: shownContent(row.after_head, row.after_len, row.after_nul, contentLimit),
  }
  if (!before || !after) {
    const only = (after ?? before)!
    const properties = Object.keys(only.properties).sort()
    const hasReferences = Array.isArray(only.references) && only.references.length > 0
    return {
      blockId: row.block_id,
      kind: after ? 'create' : 'delete',
      changed: [
        'content', 'parent',
        ...(properties.length > 0 ? ['properties' as const] : []),
        ...(hasReferences ? ['references' as const] : []),
      ],
      content: after ? {after: content.after} : {before: content.before},
      parentId: after ? {before: null, after: only.parentId} : {before: only.parentId, after: null},
      ...(properties.length > 0 ? {properties} : {}),
    }
  }
  const changed: ChangedField[] = []
  if (row.content_changed) changed.push('content')
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
      ? {content}
      : {}),
    ...(changed.includes('parent') ? {parentId: {before: before.parentId, after: after.parentId}} : {}),
    ...(properties.length > 0 ? {properties} : {}),
  }
}

const RECOGNIZED_FIELD_ROWS_SQL = `
  SELECT b.id, b.parent_id AS ownerId FROM blocks b
   WHERE b.id IN (SELECT value FROM json_each(?))
     AND ${recognizedFieldRowSql('b')}`

/** The owner of each property-storage row among `rows` — recognized field
 *  rows (the outline's own predicate) and the value rows under them. */
const propertyStorageOwners = async (repo: Repo, rows: readonly ChangeRow[]): Promise<Map<string, string>> => {
  const parentOf = new Map(rows.map(row =>
    [row.block_id, snapshotOf(row.after_meta ?? row.before_meta)?.parentId ?? null]))
  const candidates = [...new Set([...parentOf.keys(), ...parentOf.values()])].filter(id => id !== null)
  const ownerOfField = new Map((await repo.db.getAll<{id: string, ownerId: string}>(
    RECOGNIZED_FIELD_ROWS_SQL,
    [JSON.stringify(candidates), ...registryRecognitionParams(repo)],
  )).map(row => [row.id, row.ownerId]))
  const owners = new Map<string, string>()
  for (const [id, parent] of parentOf) {
    const owner = ownerOfField.get(id) ?? (parent === null ? undefined : ownerOfField.get(parent))
    if (owner !== undefined) owners.set(id, owner)
  }
  return owners
}

/** Storage rows a same-tx processor wrote for a property change the owner's
 *  own line already names. One whose owner shows no property change in that
 *  tx is kept: nothing else would report it. */
type DescribedChange = {row: ChangeRow; change: Omit<BlockChange, 'shortId'>}

const withoutCoveredPropertyStorage = async (
  repo: Repo,
  described: readonly DescribedChange[],
): Promise<DescribedChange[]> => {
  const owners = await propertyStorageOwners(repo, described.map(({row}) => row))
  const propertyOwnersByTx = new Map<string, Set<string>>()
  for (const {row, change} of described) {
    if (!change.changed.includes('properties')) continue
    const set = propertyOwnersByTx.get(row.tx_id!) ?? new Set<string>()
    set.add(row.block_id)
    propertyOwnersByTx.set(row.tx_id!, set)
  }
  return described.filter(({row}) => {
    const owner = owners.get(row.block_id)
    return owner === undefined || !propertyOwnersByTx.get(row.tx_id!)?.has(owner)
  })
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

const isoAt = (ms: number): string => new Date(ms).toISOString()

interface RecentChangesInput {
  since?: number | string
  limit?: number
  /** Include the user's own local edits, not only agent-bridge writes. */
  includeUser: boolean
}

interface RecentChangeTx {
  txId: string
  at: string
  description: string | null
  changes: BlockChange[]
  /** The cap ({@link MAX_LISTED_CHANGES}) left some of this tx's rows out —
   *  read a block's own record with block-history. */
  incomplete?: true
}

interface RecentChangesResult {
  workspaceId: string
  since: string
  agentOnly: boolean
  /** More transactions matched than `limit` returned. */
  truncated: boolean
  /** Newest first. */
  txs: RecentChangeTx[]
}

const RECENT_CONTENT_LIMIT = 200

/** Written blocks one call reads, across all its txs: `limit` bounds txs, and
 *  one tx (a large append, a subtree delete) can write thousands of blocks.
 *  Whole blocks are cut, never a block's events, so each listed block's net
 *  change stays exact. */
export const MAX_LISTED_CHANGES = 200

/** Every block the page's txs wrote, numbered in the order
 *  {@link MAX_LISTED_CHANGES} cuts in: real changes before property storage
 *  (recognized field rows and the value rows under them, which the owner's own
 *  line usually covers), then page order, then first-write order. Storage
 *  first would let a bulk property write fill the cap with rows the result
 *  hides, pushing out the owners that name them. Binds the page's tx ids, then
 *  the recognition params twice. */
const RANKED_BLOCKS_CTE = `
  WITH page AS (SELECT key AS ord, value AS tx_id FROM json_each(?)),
  written AS (
    SELECT r.tx_id, r.block_id, MIN(r.id) AS first_id, MAX(r.id) AS last_id, page.ord
      FROM row_events r JOIN page ON page.tx_id = r.tx_id
     GROUP BY r.tx_id, r.block_id
  ),
  storage AS (
    SELECT f.id FROM blocks f
     WHERE f.id IN (SELECT block_id FROM written) AND ${recognizedFieldRowSql('f')}
    UNION
    SELECT v.id FROM blocks v JOIN blocks f ON f.id = v.parent_id
     WHERE v.id IN (SELECT block_id FROM written) AND ${recognizedFieldRowSql('f')}
  ),
  ranked AS (
    SELECT tx_id, block_id, first_id, last_id,
           ROW_NUMBER() OVER (ORDER BY block_id IN (SELECT id FROM storage), ord, first_id) AS n
      FROM written
  )
`

export const recentChanges = async (repo: Repo, input: RecentChangesInput): Promise<RecentChangesResult> => {
  const workspaceId = viewWorkspace(repo, undefined)
  const since = parseSince(input.since)
  const limit = clampInt(input.limit, 20, 200)
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
  const pageIds = JSON.stringify(page.map(tx => tx.tx_id))
  const recognition = registryRecognitionParams(repo)
  const cut = new Set((await repo.db.getAll<{tx_id: string}>(
    `${RANKED_BLOCKS_CTE} SELECT DISTINCT tx_id FROM ranked WHERE n > ?`,
    [pageIds, ...recognition, ...recognition, MAX_LISTED_CHANGES],
  )).map(row => row.tx_id))
  // A block's net change in a tx: its first write's before, its last write's
  // after. One created and hard-deleted in the same tx changed nothing.
  const rows = await repo.db.getAll<ChangeRow>(
    `${RANKED_BLOCKS_CTE}
     SELECT ${changeColumnsSql('f', 'l')}
       FROM ranked k JOIN row_events f ON f.id = k.first_id JOIN row_events l ON l.id = k.last_id
      WHERE k.n <= ? AND NOT (f.before_json IS NULL AND l.after_json IS NULL)
      ORDER BY k.first_id`,
    [pageIds, ...recognition, ...recognition, RECENT_CONTENT_LIMIT, RECENT_CONTENT_LIMIT, MAX_LISTED_CHANGES],
  )
  const visible = await withoutCoveredPropertyStorage(
    repo,
    rows.map(row => ({row, change: describeChange(row, RECENT_CONTENT_LIMIT)})),
  )
  const short = await shortIds(repo, visible.map(({row}) => row.block_id))
  const changesByTx = new Map<string, BlockChange[]>()
  for (const {row, change} of visible) {
    const list = changesByTx.get(row.tx_id!) ?? []
    list.push({...change, shortId: short.get(row.block_id)!})
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
      ...(cut.has(tx.tx_id) ? {incomplete: true as const} : {}),
    })),
  }
}

interface BlockHistoryInput {
  id: string
  limit?: number
}

interface BlockHistoryEvent extends BlockChange {
  at: string
  /** `local` — a transaction on this device; `sync` — applied from the server. */
  source: 'local' | 'sync'
  txId: string | null
  description: string | null
}

interface BlockHistoryResult {
  blockId: string
  shortId: string
  /** Newest first; content cut at {@link BLOCK_HISTORY_CONTENT_CHARS}. */
  events: BlockHistoryEvent[]
  truncated: boolean
}

/** Each before/after content a history event shows, cut and marked past this:
 *  20 events of a long block would otherwise be megabytes in one reply. */
export const BLOCK_HISTORY_CONTENT_CHARS = 2000

export const blockHistory = async (repo: Repo, input: BlockHistoryInput): Promise<BlockHistoryResult> => {
  const limit = clampInt(input.limit, 20, 100)
  const rows = await repo.db.getAll<ChangeRow & {description: string | null}>(
    `SELECT ${changeColumnsSql('r', 'r')}, c.description
       FROM row_events r LEFT JOIN command_events c ON c.tx_id = r.tx_id
      WHERE r.block_id = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?`,
    [BLOCK_HISTORY_CONTENT_CHARS, BLOCK_HISTORY_CONTENT_CHARS, input.id, limit + 1],
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
      ...describeChange(row, BLOCK_HISTORY_CONTENT_CHARS),
      shortId,
    })),
  }
}
