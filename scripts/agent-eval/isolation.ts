/**
 * Keeps every task's starting graph identical: the runner snapshots the
 * workspace once, and after each task undoes whatever changed — the task's
 * own edits, collateral writes, and writes a read task should never have
 * made. Undoing generically means no task has to anticipate what an agent
 * might touch.
 */
import { changedSince, type GraphProbe, sqlAll } from './graphQueries'

interface SnapshotRow {
  id: string
  parent_id: string | null
  order_key: string
  content: string
  properties_json: string
  deleted: number
}

export type WorkspaceSnapshot = ReadonlyMap<string, SnapshotRow>

export const snapshotWorkspace = async (probe: GraphProbe): Promise<WorkspaceSnapshot> => {
  const rows = await sqlAll<SnapshotRow>(probe,
    'SELECT id, parent_id, order_key, content, properties_json, deleted FROM blocks WHERE workspace_id = ?',
    [probe.workspaceId])
  return new Map(rows.map(row => [row.id, row]))
}

export interface TaskChanges {
  /** Blocks that did not exist at snapshot time and are not deleted now. */
  created: Array<{id: string, parent_id: string | null}>
  /** Snapshot blocks whose state differs from the snapshot. */
  modified: Array<{id: string, before: SnapshotRow, after: SnapshotRow}>
}

/** Key order is not part of a property bag's value. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  }
  return value
}
const sameProperties = (a: string, b: string) =>
  a === b || JSON.stringify(canonical(JSON.parse(a))) === JSON.stringify(canonical(JSON.parse(b)))

const sameState = (a: SnapshotRow, b: SnapshotRow) =>
  a.content === b.content && sameProperties(a.properties_json, b.properties_json)
  && a.parent_id === b.parent_id && a.order_key === b.order_key && a.deleted === b.deleted

/** What differs from `snapshot` among blocks written since `since`. A block
 *  rewritten to its snapshot state does not count. */
export const changesSince = async (probe: GraphProbe, snapshot: WorkspaceSnapshot, since: number): Promise<TaskChanges> => {
  const changes: TaskChanges = {created: [], modified: []}
  for (const row of await changedSince(probe, since)) {
    const before = snapshot.get(row.id)
    if (!before) {
      if (!row.deleted) changes.created.push(row)
    } else if (!sameState(before, row)) {
      changes.modified.push({id: row.id, before, after: row})
    }
  }
  return changes
}

/** Where to re-insert a moved block: before its snapshot next-sibling when
 *  that sibling is still under the same parent, else last. */
const restorePosition = (snapshot: WorkspaceSnapshot, before: SnapshotRow) => {
  const next = [...snapshot.values()]
    .filter(row => row.parent_id === before.parent_id && !row.deleted && row.order_key > before.order_key)
    .sort((a, b) => a.order_key.localeCompare(b.order_key))[0]
  return next ? {kind: 'before', siblingId: next.id} : {kind: 'last'}
}

export const undoChanges = async (probe: GraphProbe, snapshot: WorkspaceSnapshot, changes: TaskChanges): Promise<void> => {
  const createdIds = new Set(changes.created.map(row => row.id))
  for (const row of changes.created) {
    if (row.parent_id && createdIds.has(row.parent_id)) continue
    await probe.command({type: 'delete-block', id: row.id})
  }
  for (const {id, before, after} of changes.modified) {
    if (before.deleted !== after.deleted) {
      await probe.command({type: before.deleted ? 'delete-block' : 'restore-block', id})
    }
    if (before.content !== after.content || !sameProperties(before.properties_json, after.properties_json)) {
      await probe.command({
        type: 'update-block',
        id,
        content: before.content,
        properties: JSON.parse(before.properties_json) as unknown,
        replaceProperties: true,
      })
    }
    if (before.parent_id !== after.parent_id || before.order_key !== after.order_key) {
      await probe.command({type: 'move-block', id, parentId: before.parent_id, position: restorePosition(snapshot, before)})
    }
  }
}

/** Undo, then prove it: a run must never continue on a graph that differs
 *  from the snapshot, or every later task measures something else. A moved
 *  block counts as restored once it is back under its parent — its new order
 *  key cannot equal the old one. */
export const restoreSnapshot = async (probe: GraphProbe, snapshot: WorkspaceSnapshot, since: number): Promise<TaskChanges> => {
  const changes = await changesSince(probe, snapshot, since)
  await undoChanges(probe, snapshot, changes)
  const left = await changesSince(probe, snapshot, since)
  const unrestored = [
    ...left.created.map(row => row.id),
    ...left.modified
      .filter(({before, after}) => !sameState(before, {...after, order_key: before.order_key}))
      .map(({id}) => id),
  ]
  if (unrestored.length > 0) {
    throw new Error(`could not restore ${unrestored.length} block(s) to the fixture state (${unrestored.slice(0, 5).join(', ')}); re-seed before running again`)
  }
  return changes
}

/** Changes a task was not asked to make: edits to existing blocks outside
 *  `allowedIds`, and — for a read task — any block it created. */
export const strayChanges = (changes: TaskChanges, allowedIds: ReadonlySet<string>, kind: 'read' | 'write'): number =>
  changes.modified.filter(change => !allowedIds.has(change.id)).length
  + (kind === 'read' ? changes.created.length : 0)
