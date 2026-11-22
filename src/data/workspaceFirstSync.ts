/**
 * Has this device caught up on a workspace — downloaded AND materialized its
 * first sync? Until it has, the app does not open the workspace: bootstrap's
 * get-or-create writes would otherwise mint the pages and definitions the
 * server already has.
 *
 * Once it has, a per-device marker in `client_schema_state` says so, so a later
 * backlog (or an offline boot) never re-gates it. The marker is recorded by the
 * caller that has cleared the access gate, never here: asking about a locked
 * workspace must not record it. Opening a workspace whose row is gone forgets
 * it ({@link forgetWorkspaceFirstSync}), so one left and re-joined gates again.
 *
 * Accepted:
 * - a workspace row primed from the ensure-personal RPC counts as local.
 * - the staged-queue arm of the view gap is device-wide, so another workspace's
 *   backlog holds this one's first open.
 * - caught up is "as of the last checkpoint", not complete: a workspace created
 *   on another device moments ago can arrive before that device's bootstrap
 *   rows upload, and nothing here can tell that from an empty workspace.
 * - a workspace left and re-joined without being opened while its row was
 *   absent keeps its marker.
 */
import type { Repo, ViewGap } from '@/data/repo'
import {
  DELETE_KEYED_MARKER_SQL,
  RECONCILE_FLAGS_TRUSTED_MARKER_PREFIX,
  RECONCILE_RESCAN_MARKER_PREFIX,
  RECORD_KEYED_MARKER_SQL,
  RECORD_RECONCILE_FLAGS_TRUSTED_IF_COLD_SQL,
  SELECT_KEYED_MARKER_SQL,
  WORKSPACE_FIRST_SYNC_MARKER_PREFIX,
} from '@/data/internals/clientSchema'

const markerKey = (workspaceId: string): string => `${WORKSPACE_FIRST_SYNC_MARKER_PREFIX}${workspaceId}`

type MarkerDb = Pick<Repo['db'], 'execute'>

/** PowerSync's persisted "a full checkpoint has been applied", which
 *  `Repo['db']` does not declare. */
const hasSynced = (db: Repo['db']): boolean | undefined =>
  (db as {currentStatus?: {hasSynced?: boolean}}).currentStatus?.hasSynced

export type WorkspaceFirstSync =
  | {readonly kind: 'recorded'}
  // Caught up now, marker not yet recorded.
  | {readonly kind: 'caught-up'}
  // `gap` is what holds it on this device; null while it waits on the row or
  // the download instead.
  | {readonly kind: 'pending'; readonly gap: ViewGap | null}

/**
 * Reads the workspace row FIRST, then the gap: sync status and data are only
 * ever behind what is committed, so this order cannot report caught-up early.
 * A pure read, except that a workspace whose row is gone loses its marker.
 */
export const readWorkspaceFirstSync = async (
  repo: Pick<Repo, 'db' | 'workspaceViewGap'>,
  workspaceId: string,
): Promise<WorkspaceFirstSync> => {
  const row = await repo.db.getOptional('SELECT 1 FROM workspaces WHERE id = ?', [workspaceId])
  if (row === null) {
    await forgetWorkspaceFirstSync(repo.db, workspaceId)
    return {kind: 'pending', gap: null}
  }
  if (await repo.db.getOptional(SELECT_KEYED_MARKER_SQL, [markerKey(workspaceId)]) !== null) {
    return {kind: 'recorded'}
  }
  if (hasSynced(repo.db) !== true) return {kind: 'pending', gap: null}
  const gap = await repo.workspaceViewGap(workspaceId, undefined, 'local')
  return gap === null ? {kind: 'caught-up'} : {kind: 'pending', gap}
}

export const recordWorkspaceFirstSync = async (db: MarkerDb, workspaceId: string): Promise<void> => {
  await db.execute(RECORD_KEYED_MARKER_SQL, [markerKey(workspaceId)])
}

/** For a workspace whose row is absent: whatever this device had of it is gone. */
export const forgetWorkspaceFirstSync = async (db: MarkerDb, workspaceId: string): Promise<void> => {
  await db.execute(DELETE_KEYED_MARKER_SQL, [markerKey(workspaceId)])
}

/** Call before this device's first sync of a workspace materializes any of it.
 *  Then its one-time reconcile rescan reads only the rows a drain left
 *  unapplied, instead of rewriting `blocks` from every staged row right after
 *  the first drain wrote them ({@link RECORD_RECONCILE_FLAGS_TRUSTED_IF_COLD_SQL}).
 *  Called once a drain has applied a row, it records nothing, and the rescan
 *  reads every row as before. */
export const noteColdFirstSync = async (db: MarkerDb, workspaceId: string): Promise<void> => {
  await db.execute(RECORD_RECONCILE_FLAGS_TRUSTED_IF_COLD_SQL, [
    `${RECONCILE_FLAGS_TRUSTED_MARKER_PREFIX}${workspaceId}`,
    `${RECONCILE_RESCAN_MARKER_PREFIX}${workspaceId}`,
    workspaceId,
  ])
}
