/**
 * What a task changed: every block row of its graph diffed against the
 * template the graph was copied from — by id, every column, deleted rows
 * included, never by timestamp, because the engine mints some rows at
 * `updated_at = 0`.
 *
 * Every read of the table first drains the graph's deferred work: a
 * post-commit processor the agent's writes started (a page a link mints, the
 * references a block's text derives) lands after its last tool call returned.
 * A drain does not advance timers, so a processor scheduled with a delay is
 * not waited for; the only one, the orphan-alias cleanup four seconds after a
 * link mints a page, changes nothing while the link stays.
 */
import { type GraphProbe, sqlAll } from './graphQueries'

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

/** The template's rows, by id. */
export type Snapshot = ReadonlyMap<string, SnapshotRow>

/** Waits until the graph's processors and deferred passes have nothing
 *  pending, as a harness tearing a Repo down does. */
export const settle = async (probe: GraphProbe): Promise<void> => {
  await probe.command({type: 'eval', code: 'await repo.awaitDeferredWork()'})
}

const settledRows = async (probe: GraphProbe): Promise<SnapshotRow[]> => {
  await settle(probe)
  return sqlAll<SnapshotRow>(probe, 'SELECT * FROM blocks WHERE workspace_id = ?', [probe.workspaceId])
}

export const snapshotWorkspace = async (probe: GraphProbe): Promise<Snapshot> =>
  new Map((await settledRows(probe)).map(row => [row.id, row]))

export interface TaskChanges {
  /** Rows the template does not have, deleted ones included. */
  created: SnapshotRow[]
  /** Template rows whose state differs from the template. */
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
const sameBag = (a: string, b: string) => JSON.stringify(canonical(JSON.parse(a))) === JSON.stringify(canonical(JSON.parse(b)))

/** Moved by every write, so a row whose only difference is one of these was
 *  touched, not changed. */
const RECENCY_STAMPS = new Set(['updated_at', 'user_updated_at'])

const sameState = (a: SnapshotRow, b: SnapshotRow) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
  .every(column => RECENCY_STAMPS.has(column) || a[column] === b[column])

export const diffAgainst = async (probe: GraphProbe, template: Snapshot): Promise<TaskChanges> => {
  const changes: TaskChanges = {created: [], modified: []}
  for (const row of await settledRows(probe)) {
    const before = template.get(row.id)
    if (!before) changes.created.push(row)
    else if (!sameState(before, row)) changes.modified.push({id: row.id, before, after: row})
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

const moved = (before: SnapshotRow, after: SnapshotRow) =>
  before.parent_id !== after.parent_id || before.order_key !== after.order_key

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
  return properties !== undefined && sameBag(row.properties_json, JSON.stringify(properties))
}

/** How many changes fall outside `allowed`. A block the task created and
 *  deleted again is not counted. */
export const strayChanges = (changes: TaskChanges, allowed: AllowedChanges): number =>
  changes.modified.filter(({id, before, after}) => exceedsEdit(before, after, allowed.edits.get(id) ?? NO_EDIT)).length
  + changes.created.filter(row => !row.deleted && !allowedCreation(row, allowed)).length
