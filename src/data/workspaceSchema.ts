import type { PendingStatementParameter, RawTableType } from '@powersync/web'
import type {
  PropertiesMigrationState,
  Workspace,
  WorkspaceMembership,
  WorkspaceRole,
} from '@/types'
import { isChildBackedPropertiesWorkspace } from '@/types'

// These tables are sync-only from the client's perspective: rows arrive via
// PowerSync streams (powersync/sync-config.yaml) and outgoing changes go
// through Supabase RPCs (src/data/workspaces.ts). We therefore do NOT wire
// powersync_crud triggers for them in repoInstance.ts.

type ColumnDef = {
  readonly name: string
  readonly definition: string
}

const buildPutSql = (tableName: string, columns: readonly ColumnDef[]) => `
  INSERT OR REPLACE INTO ${tableName} (
${columns.map(c => `        ${c.name}`).join(',\n')}
      ) VALUES (${columns.map(() => '?').join(', ')})
`

const buildPutParams = (columns: readonly ColumnDef[]): PendingStatementParameter[] =>
  columns.map(c => (c.name === 'id' ? 'Id' : {Column: c.name}))

const buildCreateTableSql = (tableName: string, columns: readonly ColumnDef[]) => `
  CREATE TABLE IF NOT EXISTS ${tableName} (
${columns.map(c => `    ${c.definition}`).join(',\n')}
  )
`

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------

// @projects: workspaces
export interface WorkspaceRow {
  id: string
  name: string
  owner_user_id: string
  create_time: number
  update_time: number
  // E2EE (docs/e2ee-design.html §7). encryption_mode is a UX hint /
  // server-feature-gating projection; wk_canary is the key-check blob a new
  // device decrypts to validate a pasted WK (NULL for plaintext workspaces).
  // Synced down read-only; consumed by the paste flow (§8.2) in a later phase.
  encryption_mode: string
  wk_canary: string | null
  // Properties-as-blocks rollout lever (PR #288 §6). NULLABLE on the wire
  // and locally: deployed sync rules predating the column deliver rows
  // without it (the raw-table put binds an explicit NULL, so a NOT NULL
  // DEFAULT would fail the insert — same trap as user_updated_at);
  // `parseWorkspaceRow` falls back to 'cell'.
  properties_migration: string | null
}

export const WORKSPACE_COLUMNS: readonly ColumnDef[] = [
  {name: 'id', definition: 'id TEXT PRIMARY KEY NOT NULL'},
  {name: 'name', definition: "name TEXT NOT NULL DEFAULT ''"},
  {name: 'owner_user_id', definition: 'owner_user_id TEXT NOT NULL'},
  {name: 'create_time', definition: 'create_time INTEGER NOT NULL'},
  {name: 'update_time', definition: 'update_time INTEGER NOT NULL'},
  // Mirror the server's NOT NULL DEFAULT 'none' so an upgrading device's
  // existing rows backfill to 'none' until PowerSync replays the real value
  // (§7). wk_canary stays nullable — NULL is correct for plaintext.
  {name: 'encryption_mode', definition: "encryption_mode TEXT NOT NULL DEFAULT 'none'"},
  {name: 'wk_canary', definition: 'wk_canary TEXT'},
  // Nullable (no NOT NULL): an old deployed sync-rules window binds NULL
  // here rather than failing the raw-table put; `parseWorkspaceRow` falls
  // back to 'cell'. Mirrors the server column in
  // supabase/migrations/*_add_workspaces_properties_migration.sql.
  {name: 'properties_migration', definition: 'properties_migration TEXT'},
]

export const CREATE_WORKSPACES_TABLE_SQL = buildCreateTableSql('workspaces', WORKSPACE_COLUMNS)

/**
 * Idempotent local-schema migration for the E2EE workspace columns (§7).
 * CREATE TABLE IF NOT EXISTS is a no-op on a device whose `workspaces`
 * table predates these columns, so add them explicitly. Guarded on column
 * existence so a fresh install — which already has them from
 * CREATE_WORKSPACES_TABLE_SQL — doesn't throw "duplicate column name".
 * The NOT NULL DEFAULT 'none' backfills existing rows to plaintext until
 * PowerSync replays each row's real value.
 */
export const ensureWorkspaceE2eeColumns = async (db: {
  execute: (sql: string) => Promise<unknown>
  getAll: <T>(sql: string) => Promise<T[]>
}): Promise<void> => {
  const columns = await db.getAll<{ name: string }>('PRAGMA table_info(workspaces)')
  const present = new Set(columns.map((c) => c.name))
  if (!present.has('encryption_mode')) {
    await db.execute("ALTER TABLE workspaces ADD COLUMN encryption_mode TEXT NOT NULL DEFAULT 'none'")
  }
  if (!present.has('wk_canary')) {
    await db.execute('ALTER TABLE workspaces ADD COLUMN wk_canary TEXT')
  }
}

/** Idempotent local-schema migration for the properties-as-blocks rollout
 *  lever (PR #288 §6) — same pattern as the E2EE columns above. Nullable;
 *  absence reads as 'cell' via `parseWorkspaceRow`. */
export const ensureWorkspacePropertiesMigrationColumn = async (db: {
  execute: (sql: string) => Promise<unknown>
  getAll: <T>(sql: string) => Promise<T[]>
}): Promise<void> => {
  const columns = await db.getAll<{ name: string }>('PRAGMA table_info(workspaces)')
  if (!columns.some((c) => c.name === 'properties_migration')) {
    await db.execute('ALTER TABLE workspaces ADD COLUMN properties_migration TEXT')
  }
}

export const WORKSPACES_RAW_TABLE = {
  put: {
    sql: buildPutSql('workspaces', WORKSPACE_COLUMNS),
    params: buildPutParams(WORKSPACE_COLUMNS),
  },
  delete: {
    sql: 'DELETE FROM workspaces WHERE id = ?',
    params: ['Id'],
  },
} satisfies RawTableType

export const PROPERTIES_MIGRATION_STATES: readonly PropertiesMigrationState[] =
  ['cell', 'children', 'cell-off']

/** Absent (old sync rules / pre-migration rows) and unrecognized values
 *  both read as 'cell' — fail-safe: an un-flipped reading is always
 *  dormant behavior. */
export const parsePropertiesMigration = (
  value: string | null | undefined,
): PropertiesMigrationState =>
  PROPERTIES_MIGRATION_STATES.includes(value as PropertiesMigrationState)
    ? value as PropertiesMigrationState
    : 'cell'

/** Shared flip-check (PR #288 §6): reads `properties_migration` for
 *  `workspaceId` and reports whether the workspace is at or past the
 *  children-backed state. `db` is the minimal read surface both the tx
 *  engine (`TxDb`) and `Repo` (`PowerSyncDb`) already satisfy — callers own
 *  any per-tx / per-call caching (see `TxImpl.isPropertyChildBackedWorkspace`'s
 *  `childBackedWorkspaceCache`). */
export const readIsChildBackedWorkspace = async (
  db: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>},
  workspaceId: string,
): Promise<boolean> => {
  const row = await db.getOptional<{properties_migration: string | null}>(
    'SELECT properties_migration FROM workspaces WHERE id = ?',
    [workspaceId],
  )
  return isChildBackedPropertiesWorkspace(parsePropertiesMigration(row?.properties_migration))
}

export const parseWorkspaceRow = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  ownerUserId: row.owner_user_id,
  createTime: row.create_time,
  updateTime: row.update_time,
  encryptionMode: row.encryption_mode,
  wkCanary: row.wk_canary,
  propertiesMigration: parsePropertiesMigration(row.properties_migration),
})

// ---------------------------------------------------------------------------
// workspace_members
// ---------------------------------------------------------------------------

// @projects: workspace_members
export interface WorkspaceMemberRow {
  id: string
  workspace_id: string
  user_id: string
  role: string
  create_time: number
}

export const WORKSPACE_MEMBER_COLUMNS: readonly ColumnDef[] = [
  {name: 'id', definition: 'id TEXT PRIMARY KEY NOT NULL'},
  {name: 'workspace_id', definition: 'workspace_id TEXT NOT NULL'},
  {name: 'user_id', definition: 'user_id TEXT NOT NULL'},
  {name: 'role', definition: 'role TEXT NOT NULL'},
  {name: 'create_time', definition: 'create_time INTEGER NOT NULL'},
]

export const CREATE_WORKSPACE_MEMBERS_TABLE_SQL = buildCreateTableSql(
  'workspace_members',
  WORKSPACE_MEMBER_COLUMNS,
)

export const CREATE_WORKSPACE_MEMBERS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
  ON workspace_members (user_id)
`

export const WORKSPACE_MEMBERS_RAW_TABLE = {
  put: {
    sql: buildPutSql('workspace_members', WORKSPACE_MEMBER_COLUMNS),
    params: buildPutParams(WORKSPACE_MEMBER_COLUMNS),
  },
  delete: {
    sql: 'DELETE FROM workspace_members WHERE id = ?',
    params: ['Id'],
  },
} satisfies RawTableType

export const parseWorkspaceMemberRow = (row: WorkspaceMemberRow): WorkspaceMembership => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role as WorkspaceRole,
  createTime: row.create_time,
})
