/**
 * Has this device caught up on a workspace — downloaded AND materialized its
 * first sync? Until it has, the app does not open the workspace: bootstrap's
 * get-or-create writes would otherwise mint the pages and definitions the
 * server already has.
 *
 * Once it has, a per-device marker in `client_schema_state` says so, so a later
 * backlog (or an offline boot) never re-gates it. The marker is recorded by the
 * caller that has cleared the access gate, never here: asking about a locked
 * workspace must not record it.
 *
 * Accepted:
 * - a workspace row primed from the ensure-personal RPC counts as local.
 * - the staged-queue arm of the view gap is device-wide, so another workspace's
 *   backlog holds this one's first open.
 * - caught up is "as of the last checkpoint", not complete: a workspace created
 *   on another device moments ago can arrive before that device's bootstrap
 *   rows upload, and nothing here can tell that from an empty workspace.
 */
import type { Repo, ViewGap } from '@/data/repo'
import { DELETE_KEYED_MARKER_SQL, RECORD_KEYED_MARKER_SQL, SELECT_KEYED_MARKER_SQL } from '@/data/internals/clientSchema'

export const WORKSPACE_FIRST_SYNC_MARKER_PREFIX = 'workspace_first_sync_v1:'

const markerKey = (workspaceId: string): string => `${WORKSPACE_FIRST_SYNC_MARKER_PREFIX}${workspaceId}`

type MarkerDb = Pick<Repo['db'], 'execute'>

/** PowerSync's persisted "a full checkpoint has been applied", which
 *  `Repo['db']` does not declare. */
const hasSynced = (db: Repo['db']): boolean | undefined =>
  (db as {currentStatus?: {hasSynced?: boolean}}).currentStatus?.hasSynced

export type WorkspaceFirstSync =
  | {readonly kind: 'recorded'}
  /** Caught up now, marker not yet recorded. */
  | {readonly kind: 'caught-up'}
  /** `gap` is what holds it on this device; null while it waits on the row or
   *  the download instead. */
  | {readonly kind: 'pending'; readonly gap: ViewGap | null}

/**
 * Reads the workspace row FIRST, then the gap: sync status and data are only
 * ever behind what is committed, so this order cannot report caught-up early.
 * A pure read, except that a workspace whose row is gone loses its marker — one
 * left and re-joined must gate again.
 */
export const readWorkspaceFirstSync = async (
  repo: Pick<Repo, 'db' | 'workspaceViewGap'>,
  workspaceId: string,
): Promise<WorkspaceFirstSync> => {
  const row = await repo.db.getOptional('SELECT 1 FROM workspaces WHERE id = ?', [workspaceId])
  if (row === null) {
    await repo.db.execute(DELETE_KEYED_MARKER_SQL, [markerKey(workspaceId)])
    return {kind: 'pending', gap: null}
  }
  if (await repo.db.getOptional(SELECT_KEYED_MARKER_SQL, [markerKey(workspaceId)]) !== null) {
    return {kind: 'recorded'}
  }
  if (hasSynced(repo.db) !== true) return {kind: 'pending', gap: null}
  const gap = await repo.workspaceViewGap(workspaceId, undefined, 'local')
  return gap === null ? {kind: 'caught-up'} : {kind: 'pending', gap}
}

export const workspaceCaughtUp = async (
  repo: Pick<Repo, 'db' | 'workspaceViewGap'>,
  workspaceId: string,
): Promise<boolean> => (await readWorkspaceFirstSync(repo, workspaceId)).kind !== 'pending'

export const recordWorkspaceFirstSync = async (db: MarkerDb, workspaceId: string): Promise<void> => {
  await db.execute(RECORD_KEYED_MARKER_SQL, [markerKey(workspaceId)])
}
