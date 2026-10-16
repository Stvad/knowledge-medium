/**
 * Keeps every task's starting graph identical. The runner snapshots every
 * block row once; after each task it diffs the WHOLE table against that
 * snapshot — by id, every column, deleted rows included, never by timestamp,
 * because the engine mints some rows at `updated_at = 0` — and undoes every
 * difference: the task's own edits, collateral writes, and writes a read task
 * should never have made. Rows the task created are purged outright: a
 * soft-deleted leftover is still visible to an agent's raw SQL and would
 * drift every later run's results.
 *
 * Every read of the table waits for the graph to go quiet first: a write
 * still in flight — a tool call `claude` left running, or a post-commit
 * processor started by the agent's writes or by the undo's own — would
 * otherwise land after the read, inside the next task.
 *
 * The app's own per-user state (the subtree under the `user` page: ui-state,
 * prefs, panels) churns by itself and is not part of what a task measures, so
 * it is outside the snapshot.
 */
import { type GraphProbe, purgeBlocks, sqlAll } from './graphQueries'

/** A `blocks` row with every column, derived ones such as `references_json`
 *  included, so a column added later is compared without being listed here. */
export interface SnapshotRow {
  id: string
  parent_id: string | null
  order_key: string
  content: string
  properties_json: string
  deleted: number
  updated_at: number
  user_updated_at: number | null
  [column: string]: unknown
}

/** Mutable: a block moved back gets a new order key, which becomes its
 *  snapshot key once the restore is verified. */
export type WorkspaceSnapshot = Map<string, SnapshotRow>

export const snapshotFromRows = (rows: readonly SnapshotRow[]): WorkspaceSnapshot =>
  new Map(rows.map(row => [row.id, row]))

/** Waits until nothing in the workspace has been written for `quietMs`.
 *  Gives up after `maxMs`. */
export interface QuietOptions {
  quietMs?: number
  maxMs?: number
}

export const waitForQuiet = async (probe: GraphProbe, {quietMs = 1_500, maxMs = 20_000}: QuietOptions = {}): Promise<void> => {
  const fingerprint = async () => JSON.stringify(await sqlAll(probe,
    'SELECT count(*) AS rows, max(updated_at) AS updated, max(created_at) AS created FROM blocks WHERE workspace_id = ?',
    [probe.workspaceId]))
  const deadline = Date.now() + maxMs
  let last = await fingerprint()
  let stableSince = Date.now()
  while (Date.now() - stableSince < quietMs && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(250, quietMs)))
    const next = await fingerprint()
    if (next !== last) {
      last = next
      stableSince = Date.now()
    }
  }
}

const settledRows = async (probe: GraphProbe, quiet: QuietOptions): Promise<SnapshotRow[]> => {
  await waitForQuiet(probe, quiet)
  return sqlAll<SnapshotRow>(probe, `
    WITH RECURSIVE app_state(id) AS (
      SELECT id FROM blocks WHERE workspace_id = ?
        AND EXISTS (SELECT 1 FROM json_each(properties_json, '$.types') WHERE value = 'user')
      UNION ALL
      SELECT b.id FROM blocks b JOIN app_state ON b.parent_id = app_state.id
    )
    SELECT * FROM blocks WHERE workspace_id = ? AND id NOT IN (SELECT id FROM app_state)`,
  [probe.workspaceId, probe.workspaceId])
}

export const snapshotWorkspace = async (probe: GraphProbe, quiet: QuietOptions = {}): Promise<WorkspaceSnapshot> =>
  snapshotFromRows(await settledRows(probe, quiet))

export interface TaskChanges {
  /** Rows that did not exist at snapshot time, deleted ones included. */
  created: SnapshotRow[]
  /** Snapshot rows whose state differs from the snapshot. */
  modified: Array<{id: string, before: SnapshotRow, after: SnapshotRow}>
}

/** Key order is not part of a JSON column's value. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]))
  }
  return value
}
const JSON_COLUMNS = new Set(['properties_json', 'references_json'])
const sameColumn = (column: string, a: unknown, b: unknown) => a === b
  || (JSON_COLUMNS.has(column) && typeof a === 'string' && typeof b === 'string'
    && JSON.stringify(canonical(JSON.parse(a))) === JSON.stringify(canonical(JSON.parse(b))))

/** Every write moves these, the undo's own included, so they are written
 *  back raw rather than compared. */
const RECENCY_STAMPS = new Set(['updated_at', 'user_updated_at'])

const sameState = (a: SnapshotRow, b: SnapshotRow) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
  .every(column => RECENCY_STAMPS.has(column) || sameColumn(column, a[column], b[column]))

const moved = (before: SnapshotRow, after: SnapshotRow) =>
  before.parent_id !== after.parent_id || before.order_key !== after.order_key

/** Order keys compare by code unit, as the app and SQLite order them. */
const byOrderKey = (a: SnapshotRow, b: SnapshotRow) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0)

const changesBetween = (snapshot: WorkspaceSnapshot, rows: readonly SnapshotRow[]): TaskChanges => {
  const changes: TaskChanges = {created: [], modified: []}
  for (const row of rows) {
    const before = snapshot.get(row.id)
    if (!before) changes.created.push(row)
    else if (!sameState(before, row)) changes.modified.push({id: row.id, before, after: row})
  }
  return changes
}

export const diffAgainst = async (probe: GraphProbe, snapshot: WorkspaceSnapshot, quiet: QuietOptions = {}): Promise<TaskChanges> =>
  changesBetween(snapshot, await settledRows(probe, quiet))

/** Puts every row back, in an order where each step's preconditions hold:
 *  revived rows before edits (an edit refuses a deleted row), edits before
 *  moves, moves before removing created rows (a fixture block an agent moved
 *  under a new block must come out first), tombstones re-deleted last.
 *  Derived columns are left to the processors these writes start. */
const undoChanges = async (probe: GraphProbe, snapshot: WorkspaceSnapshot, changes: TaskChanges): Promise<void> => {
  for (const {id, before, after} of changes.modified) {
    if (!before.deleted && after.deleted) await probe.command({type: 'restore-block', id})
  }
  for (const {id, before, after} of changes.modified) {
    if (before.content !== after.content || !sameColumn('properties_json', before.properties_json, after.properties_json)) {
      await probe.command({
        type: 'update-block',
        id,
        content: before.content,
        properties: JSON.parse(before.properties_json) as unknown,
        replaceProperties: true,
      })
    }
  }
  // Last sibling first: a block's snapshot next-sibling is then either one
  // that never moved or one already put back, so the anchor is always live.
  const moves = changes.modified.filter(({before, after}) => moved(before, after))
    .sort((a, b) => byOrderKey(b.before, a.before))
  for (const {id, before} of moves) {
    const next = [...snapshot.values()]
      .filter(row => row.parent_id === before.parent_id && !row.deleted && row.order_key > before.order_key)
      .sort(byOrderKey)[0]
    await probe.command({
      type: 'move-block',
      id,
      parentId: before.parent_id,
      position: next ? {kind: 'before', siblingId: next.id} : {kind: 'last'},
    })
  }
  // Deleted through the app first, so its cached queries (alias lookups,
  // search handles) drop the rows; a raw delete alone leaves them answering.
  const createdIds = new Set(changes.created.map(row => row.id))
  for (const row of changes.created) {
    if (!row.deleted && !(row.parent_id && createdIds.has(row.parent_id))) await probe.command({type: 'delete-block', id: row.id})
  }
  await purgeBlocks(probe, [...createdIds])
  for (const {id, before, after} of changes.modified) {
    if (before.deleted && !after.deleted) await probe.command({type: 'delete-block', id})
  }
}

/** Undo, then prove it on the settled graph: a run must never continue on a
 *  graph that differs from the snapshot, or every later task measures
 *  something else. A moved block counts as restored once it is back under its
 *  parent — its new order key cannot equal the old one, and becomes its
 *  snapshot key. Then every row whose recency stamps moved gets the snapshot's
 *  back, whoever moved them: recency queries order by them, and a restored
 *  block must not jump to the top of a later task's results. */
export const restoreSnapshot = async (
  probe: GraphProbe,
  snapshot: WorkspaceSnapshot,
  quiet: QuietOptions = {},
): Promise<TaskChanges> => {
  const changes = await diffAgainst(probe, snapshot, quiet)
  await undoChanges(probe, snapshot, changes)
  const rows = await settledRows(probe, quiet)
  const left = changesBetween(snapshot, rows)
  const unrestored = [
    ...left.created.map(row => row.id),
    ...left.modified.filter(({before, after}) => !sameState(before, {...after, order_key: before.order_key})).map(({id}) => id),
  ]
  if (unrestored.length > 0) {
    throw new Error(`could not restore ${unrestored.length} block(s) to the fixture state (${unrestored.slice(0, 5).join(', ')}); re-seed before running again`)
  }
  for (const {id, after} of left.modified) snapshot.set(id, {...snapshot.get(id)!, order_key: after.order_key})
  // A raw write is safe only because runs are refused on any tab that syncs;
  // through repo.tx there is no way to set these, and a raw write starts no
  // processor that could move them again.
  for (const row of rows) {
    const before = snapshot.get(row.id)!
    if (row.updated_at === before.updated_at && row.user_updated_at === before.user_updated_at) continue
    await probe.command({
      type: 'sql',
      mode: 'execute',
      sql: 'UPDATE blocks SET updated_at = ?, user_updated_at = ? WHERE id = ?',
      params: [before.updated_at, before.user_updated_at, row.id],
      allowSyncedWrite: true,
    })
  }
  return changes
}

/** The fields of an existing block a task may change. Moving or deleting a
 *  block is never allowed: no task asks for it. */
export interface AllowedEdit {
  content?: true
  /** Property keys; every other key must keep its value. */
  properties?: readonly string[]
}

/** What a task was asked to change: fields of existing blocks, by block id,
 *  and blocks under (or equal to) which it may create. A read task gets
 *  neither. */
export interface AllowedChanges {
  edits: ReadonlyMap<string, AllowedEdit>
  createRoots: ReadonlySet<string>
}

const NO_EDIT: AllowedEdit = {}

/** Judged on the fields an agent writes; derived columns and recency stamps
 *  follow from them. */
const exceedsEdit = (before: SnapshotRow, after: SnapshotRow, edit: AllowedEdit): boolean => {
  const otherProperties = (json: string) => {
    const bag = JSON.parse(json) as Record<string, unknown>
    for (const key of edit.properties ?? []) delete bag[key]
    return JSON.stringify(canonical(bag))
  }
  return (!edit.content && before.content !== after.content)
    || otherProperties(before.properties_json) !== otherProperties(after.properties_json)
    || moved(before, after)
    || before.deleted !== after.deleted
}

/** How many changes fall outside `allowed`. A block the task created and
 *  deleted again is not counted. */
export const strayChanges = (changes: TaskChanges, allowed: AllowedChanges): number => {
  const created = new Map(changes.created.map(row => [row.id, row]))
  const owned = (row: {id: string, parent_id: string | null}): boolean => {
    if (allowed.createRoots.has(row.id)) return true
    if (row.parent_id === null) return false
    if (allowed.createRoots.has(row.parent_id)) return true
    const parent = created.get(row.parent_id)
    return parent !== undefined && owned(parent)
  }
  return changes.modified.filter(({id, before, after}) => exceedsEdit(before, after, allowed.edits.get(id) ?? NO_EDIT)).length
    + changes.created.filter(row => !row.deleted && !owned(row)).length
}
