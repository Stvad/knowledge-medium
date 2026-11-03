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

type ChangedField = 'content' | 'parent' | 'order' | 'properties' | 'references' | 'deleted'

const propertyEntriesSql = (snapshot: string): string =>
  `SELECT key, type, value FROM json_each(${snapshot}, '$.properties')`

/** The names of the properties whose stored value differs between snapshot
 *  JSON `before` and `after` — set-wise, so each bag is read twice whatever
 *  its size; a NULL snapshot has none, so every name of the other differs. */
const changedPropertyNamesSql = (before: string, after: string): string => `
  SELECT key FROM (${propertyEntriesSql(before)} EXCEPT ${propertyEntriesSql(after)})
  UNION SELECT key FROM (${propertyEntriesSql(after)} EXCEPT ${propertyEntriesSql(before)})`

/** Whether each field the views report differs between snapshot JSON
 *  `before` and `after`. The one owner of "what changed": the views' `changed`
 *  list and the net-change filter both read it, so nothing the views cannot
 *  name (a write stamp, a property bag's key order) counts as a change. */
const FIELD_CHANGES: Record<ChangedField, (before: string, after: string) => string> = {
  content: (b, a) => `json_extract(${b}, '$.content') IS NOT json_extract(${a}, '$.content')`,
  parent: (b, a) => `json_extract(${b}, '$.parentId') IS NOT json_extract(${a}, '$.parentId')`,
  order: (b, a) => `json_extract(${b}, '$.orderKey') IS NOT json_extract(${a}, '$.orderKey')`,
  properties: (b, a) => `EXISTS (${changedPropertyNamesSql(b, a)})`,
  references: (b, a) =>
    `coalesce(json_extract(${b}, '$.references'), '[]') IS NOT coalesce(json_extract(${a}, '$.references'), '[]')`,
  deleted: (b, a) => `json_extract(${b}, '$.deleted') IS NOT json_extract(${a}, '$.deleted')`,
}
const CHANGED_FIELDS = Object.keys(FIELD_CHANGES) as ChangedField[]

export const LISTED_PROPERTY_NAMES = 20

/** A change as the views read it: the before / after snapshots without their
 *  content, properties or references; the content as a bounded head with its
 *  full length; which fields changed; and the first changed property names
 *  with their count — all from SQL, so a megabyte content or property bag is
 *  never loaded only to be cut or compared. See {@link changeColumnsSql}. */
type ChangeRow = {
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
  /** JSON array: the first {@link LISTED_PROPERTY_NAMES} changed property
   *  names, by name — every name the one snapshot has, for a create or delete. */
  property_names: string
  property_count: number
} & Record<`changed_${ChangedField}`, number>

/** The SELECT columns of a {@link ChangeRow} whose before snapshot is row
 *  `b`'s and after snapshot row `a`'s — one row_events row, or a block's
 *  first and last write in a tx. Binds the content head length twice. */
const changeColumnsSql = (b: string, a: string): string => {
  const before = `${b}.before_json`
  const after = `${a}.after_json`
  return `
  ${a}.tx_id AS tx_id, ${a}.block_id AS block_id, ${a}.source AS source, ${a}.created_at AS created_at,
  json_remove(${before}, '$.content', '$.properties', '$.references') AS before_meta,
  json_remove(${after}, '$.content', '$.properties', '$.references') AS after_meta,
  substr(json_extract(${before}, '$.content'), 1, ?) AS before_head,
  length(json_extract(${before}, '$.content')) AS before_len,
  substr(json_extract(${after}, '$.content'), 1, ?) AS after_head,
  length(json_extract(${after}, '$.content')) AS after_len,
  instr(CAST(json_extract(${before}, '$.content') AS BLOB), x'00') > 0 AS before_nul,
  instr(CAST(json_extract(${after}, '$.content') AS BLOB), x'00') > 0 AS after_nul,
  ${CHANGED_FIELDS.map(field => `${FIELD_CHANGES[field](before, after)} AS changed_${field}`).join(',\n  ')},
  (SELECT json_group_array(key) FROM (
    SELECT key FROM (${changedPropertyNamesSql(before, after)}) ORDER BY key LIMIT ${LISTED_PROPERTY_NAMES}
  )) AS property_names,
  (SELECT count(*) FROM (${changedPropertyNamesSql(before, after)})) AS property_count`
}

/** A block's net change in a tx is its first write's before and its last
 *  write's after (row_events rows `first` and `last`), changed when a field
 *  the views report differs — a create or delete always does, in content,
 *  which no row lacks. Both the tx page and the block ranking filter on it
 *  before their LIMIT. */
const netChangeSql = (first: string, last: string): string =>
  `(${CHANGED_FIELDS.map(field => FIELD_CHANGES[field](`${first}.before_json`, `${last}.after_json`)).join(' OR ')})`

interface Snapshot {
  parentId: string | null
  deleted: boolean
}

const snapshotOf = (json: string | null): Snapshot | null => {
  if (json === null) return null
  const raw = JSON.parse(json) as Partial<Snapshot>
  return {
    parentId: raw.parentId ?? null,
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

interface BlockChange {
  blockId: string
  /** Unique id prefix, as the read views print it (`^short`). */
  shortId: string
  kind: ChangeKind
  /** What this write changed, compared field by field. */
  changed: ChangedField[]
  content?: {before?: string; after?: string}
  parentId?: {before: string | null; after: string | null}
  /** Property names whose stored value differs, the first
   *  {@link LISTED_PROPERTY_NAMES} of them by name. */
  properties?: string[]
  /** Further property names that differ, not listed. */
  propertiesOmitted?: number
}

const propertyNameFields = (row: ChangeRow): Pick<BlockChange, 'properties' | 'propertiesOmitted'> =>
  row.property_count === 0 ? {} : {
    properties: JSON.parse(row.property_names) as string[],
    ...(row.property_count > LISTED_PROPERTY_NAMES
      ? {propertiesOmitted: row.property_count - LISTED_PROPERTY_NAMES}
      : {}),
  }

const describeChange = (row: ChangeRow, contentLimit: number): Omit<BlockChange, 'shortId'> => {
  const before = snapshotOf(row.before_meta)
  const after = snapshotOf(row.after_meta)
  const content = {
    before: shownContent(row.before_head, row.before_len, row.before_nul, contentLimit),
    after: shownContent(row.after_head, row.after_len, row.after_nul, contentLimit),
  }
  if (!before || !after) {
    const only = (after ?? before)!
    return {
      blockId: row.block_id,
      kind: after ? 'create' : 'delete',
      // Against nothing, a bag or a reference list changed when it is non-empty.
      changed: [
        'content', 'parent',
        ...(row.changed_properties ? ['properties' as const] : []),
        ...(row.changed_references ? ['references' as const] : []),
      ],
      content: after ? {after: content.after} : {before: content.before},
      parentId: after ? {before: null, after: only.parentId} : {before: only.parentId, after: null},
      ...propertyNameFields(row),
    }
  }
  const changed = CHANGED_FIELDS.filter(field => row[`changed_${field}`])

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
    ...propertyNameFields(row),
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

/** Every block the page's txs changed, numbered in the order
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
  changed AS (
    SELECT w.* FROM written w
      JOIN row_events f ON f.id = w.first_id JOIN row_events l ON l.id = w.last_id
     WHERE ${netChangeSql('f', 'l')}
  ),
  storage AS (
    SELECT f.id FROM blocks f
     WHERE f.id IN (SELECT block_id FROM changed) AND ${recognizedFieldRowSql('f')}
    UNION
    SELECT v.id FROM blocks v JOIN blocks f ON f.id = v.parent_id
     WHERE v.id IN (SELECT block_id FROM changed) AND ${recognizedFieldRowSql('f')}
  ),
  ranked AS (
    SELECT tx_id, block_id, first_id, last_id,
           ROW_NUMBER() OVER (ORDER BY block_id IN (SELECT id FROM storage), ord, first_id) AS n
      FROM changed
  )
`

export const recentChanges = async (repo: Repo, input: RecentChangesInput): Promise<RecentChangesResult> => {
  const workspaceId = viewWorkspace(repo, undefined)
  const since = parseSince(input.since)
  const limit = clampInt(input.limit, 20, 200)
  // Document edits only: UI-state and preference txs are not changes to review.
  const txs = await repo.db.getAll<{tx_id: string; description: string | null; created_at: number}>(
    `SELECT c.tx_id, c.description, c.created_at FROM command_events c
      WHERE c.workspace_id = ? AND c.scope = ? AND c.created_at >= ?
        ${input.includeUser ? '' : 'AND substr(c.description, 1, ?) = ?'}
        AND EXISTS (
          SELECT 1 FROM (
            SELECT MIN(id) AS first_id, MAX(id) AS last_id FROM row_events WHERE tx_id = c.tx_id GROUP BY block_id
          ) w JOIN row_events f ON f.id = w.first_id JOIN row_events l ON l.id = w.last_id
           WHERE ${netChangeSql('f', 'l')})
      ORDER BY c.created_at DESC, c.rowid DESC
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
  // A block's net change in a tx: its first write's before, its last write's after.
  const rows = await repo.db.getAll<ChangeRow>(
    `${RANKED_BLOCKS_CTE}
     SELECT ${changeColumnsSql('f', 'l')}
       FROM ranked k JOIN row_events f ON f.id = k.first_id JOIN row_events l ON l.id = k.last_id
      WHERE k.n <= ?
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
