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
 * The app's own per-user state (the state roots under each user page:
 * ui-state, preferences, panels) churns by itself and is not part of what a
 * task measures, so it is outside the snapshot. The user page itself is an
 * ordinary page and is compared, notes written on it included. Which rows
 * are app state is fixed when the snapshot is taken: a fixture row is
 * compared wherever it ends up.
 */
import { userStateRootBlockIds } from '@/data/derivedIds'
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

export interface WorkspaceSnapshot {
  /** Mutable: a block moved back gets a new order key, which becomes its
   *  snapshot key once the restore is verified. */
  rows: Map<string, SnapshotRow>
  /** The app's own state when the snapshot was taken, parents before
   *  children, and whether each row was live then. */
  appState: ReadonlyMap<string, boolean>
}

/** A snapshot as the run journal stores it. */
export interface StoredSnapshot {
  rows: SnapshotRow[]
  appState: Array<[string, boolean]>
}

export const storeSnapshot = (snapshot: WorkspaceSnapshot): StoredSnapshot =>
  ({rows: [...snapshot.rows.values()], appState: [...snapshot.appState]})

export const loadSnapshot = (stored: StoredSnapshot): WorkspaceSnapshot =>
  ({rows: new Map(stored.rows.map(row => [row.id, row])), appState: new Map(stored.appState)})

/** `seeds` and the rows of `rows` under them, parents before children,
 *  never descending into a compared row. */
const appStateIn = (seeds: Iterable<string>, rows: readonly SnapshotRow[], compared: ReadonlyMap<string, SnapshotRow>): Set<string> => {
  const children = new Map<string, SnapshotRow[]>()
  for (const row of rows) {
    if (row.parent_id !== null) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row])
  }
  const found = new Set(seeds)
  for (const id of found) {
    for (const child of children.get(id) ?? []) {
      if (!compared.has(child.id)) found.add(child.id)
    }
  }
  return found
}

const isUserPage = (row: SnapshotRow) => {
  const {types} = JSON.parse(row.properties_json) as {types?: unknown}
  return Array.isArray(types) && types.includes('user')
}

/** The state roots the app derives from each user page, and what is under them. */
const snapshotFromRows = (rows: readonly SnapshotRow[]): WorkspaceSnapshot => {
  const ids = new Set(rows.map(row => row.id))
  const roots = rows.filter(isUserPage).flatMap(page => userStateRootBlockIds(page.id)).filter(id => ids.has(id))
  const appState = appStateIn(roots, rows, new Map())
  const byId = new Map(rows.map(row => [row.id, row]))
  return {
    rows: new Map(rows.filter(row => !appState.has(row.id)).map(row => [row.id, row])),
    appState: new Map([...appState].map(id => [id, byId.get(id)?.deleted === 0])),
  }
}

/** Waits until nothing in the workspace has been written for `quietMs`, and
 *  throws when that has not happened after `maxMs`: a graph still being
 *  written to is not one a diff can be trusted on. */
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
  while (Date.now() - stableSince < quietMs) {
    if (Date.now() >= deadline) throw new Error(`the graph was still being written to after ${maxMs / 1000}s; stop whatever is writing to it`)
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
  return sqlAll<SnapshotRow>(probe, 'SELECT * FROM blocks WHERE workspace_id = ?', [probe.workspaceId])
}

export const snapshotWorkspace = async (probe: GraphProbe, quiet: QuietOptions = {}): Promise<WorkspaceSnapshot> =>
  snapshotFromRows(await settledRows(probe, quiet))

export interface TaskChanges {
  /** Rows that did not exist at snapshot time, deleted ones included. */
  created: SnapshotRow[]
  /** Snapshot rows whose state differs from the snapshot. */
  modified: Array<{id: string, before: SnapshotRow, after: SnapshotRow}>
  /** App-state rows live at snapshot time and deleted now, parents first:
   *  deleting a user page tombstones its state too, and reviving the page
   *  does not bring that back. */
  appStateDeleted: string[]
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
/** Defence in depth for JSON columns: the undo writes a bag back in its
 *  original key order, so a reordering is not seen today. */
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

const stampsMoved = (before: SnapshotRow, after: SnapshotRow) =>
  before.updated_at !== after.updated_at || before.user_updated_at !== after.user_updated_at

const changesBetween = (snapshot: WorkspaceSnapshot, rows: readonly SnapshotRow[]): TaskChanges => {
  const appState = appStateIn(snapshot.appState.keys(), rows, snapshot.rows)
  const deletedNow = new Set(rows.filter(row => row.deleted).map(row => row.id))
  const changes: TaskChanges = {
    created: [],
    modified: [],
    appStateDeleted: [...snapshot.appState].filter(([id, live]) => live && deletedNow.has(id)).map(([id]) => id),
  }
  for (const row of rows) {
    if (appState.has(row.id)) continue
    const before = snapshot.rows.get(row.id)
    if (!before) changes.created.push(row)
    else if (!sameState(before, row)) changes.modified.push({id: row.id, before, after: row})
  }
  return changes
}

export const diffAgainst = async (probe: GraphProbe, snapshot: WorkspaceSnapshot, quiet: QuietOptions = {}): Promise<TaskChanges> =>
  changesBetween(snapshot, await settledRows(probe, quiet))

/** Puts every row back, in an order where each step's preconditions hold:
 *  fixture rows the task put under a block it created come out first, or the
 *  purge would take them along; created rows go before any field is put back,
 *  since one can hold a key a restored field needs (a page that took over
 *  another's name); revived rows, parents first, before edits (an edit
 *  refuses a deleted row); moves once every anchor is live, last sibling
 *  first; tombstones
 *  re-deleted last. Derived columns are left to the processors these writes
 *  start. */
const undoChanges = async (probe: GraphProbe, snapshot: WorkspaceSnapshot, changes: TaskChanges): Promise<void> => {
  const createdIds = new Set(changes.created.map(row => row.id))
  const revive = (id: string) => probe.command({type: 'restore-block', id})
  const rescued = changes.modified.filter(({after}) => after.parent_id !== null && createdIds.has(after.parent_id))
  for (const {id, before, after} of rescued) {
    if (after.deleted) await revive(id)
    await probe.command({type: 'move-block', id, parentId: before.parent_id, position: {kind: 'last'}})
  }
  await purgeBlocks(probe, [...createdIds])
  // Parents first: a block cannot come back under a deleted parent, and a
  // task may have deleted both (one moved under the other, then that deleted).
  const toRevive = new Map(changes.modified
    .filter(({id, before, after}) => !before.deleted && after.deleted && !rescued.some(change => change.id === id))
    .map(({id, after}) => [id, after.parent_id]))
  while (toRevive.size > 0) {
    const ready = [...toRevive].filter(([, parent]) => parent === null || !toRevive.has(parent))
    if (ready.length === 0) break // not reachable in a tree; the proof reports what is left
    for (const [id] of ready) {
      await revive(id)
      toRevive.delete(id)
    }
  }
  for (const id of changes.appStateDeleted) await revive(id)
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
    const next = [...snapshot.rows.values()]
      .filter(row => row.parent_id === before.parent_id && !row.deleted && row.order_key > before.order_key)
      .sort(byOrderKey)[0]
    await probe.command({
      type: 'move-block',
      id,
      parentId: before.parent_id,
      position: next ? {kind: 'before', siblingId: next.id} : {kind: 'last'},
    })
  }
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
    ...left.appStateDeleted,
    ...left.modified.filter(({before, after}) => !sameState(before, {...after, order_key: before.order_key})).map(({id}) => id),
  ]
  if (unrestored.length > 0) {
    throw new Error(`could not restore ${unrestored.length} block(s) to the fixture state (${unrestored.slice(0, 5).join(', ')}); re-seed before running again`)
  }
  for (const {id, after} of left.modified) snapshot.rows.set(id, {...snapshot.rows.get(id)!, order_key: after.order_key})
  // A raw write is safe only because runs are refused on any tab that syncs;
  // through repo.tx there is no way to set these, and a raw write starts no
  // processor that could move them again.
  for (const row of rows) {
    const before = snapshot.rows.get(row.id)
    if (!before || !stampsMoved(before, row)) continue
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
 *  and the blocks it was asked to create, each with exactly the properties it
 *  must carry. A read task gets neither. */
export interface AllowedChanges {
  edits: ReadonlyMap<string, AllowedEdit>
  creates: ReadonlyMap<string, Readonly<Record<string, unknown>>>
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

const allowedCreation = (row: SnapshotRow, allowed: AllowedChanges): boolean => {
  const properties = allowed.creates.get(row.id)
  return properties !== undefined && sameColumn('properties_json', row.properties_json, JSON.stringify(properties))
}

/** How many changes fall outside `allowed`. A block the task created and
 *  deleted again is not counted. */
export const strayChanges = (changes: Pick<TaskChanges, 'created' | 'modified'>, allowed: AllowedChanges): number =>
  changes.modified.filter(({id, before, after}) => exceedsEdit(before, after, allowed.edits.get(id) ?? NO_EDIT)).length
  + changes.created.filter(row => !row.deleted && !allowedCreation(row, allowed)).length
