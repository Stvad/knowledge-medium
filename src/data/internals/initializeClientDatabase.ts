import { Schema, type CommonPowerSyncDatabase } from '@powersync/common'
import {
  BLOCKS_SYNCED_RAW_TABLE,
  CREATE_BLOCKS_PARENT_DELETED_INDEX_SQL,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_NEEDS_APPLY_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_FIELD_FORM_INDEX_SQL,
  CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL,
  dropStaleAnyFieldFormIndex,
  CREATE_BLOCKS_REFERENCE_CANDIDATES_INDEX_SQL,
  CREATE_BLOCKS_BEING_EDITED_INDEX_SQL,
  CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL,
  ensureBlockLocalColumns,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
  WORKSPACES_RAW_TABLE,
  WORKSPACE_MEMBERS_RAW_TABLE,
  ensureWorkspaceE2eeColumns,
  ensureWorkspacePropertiesMigrationColumn,
} from '@/data/workspaceSchema'
import {
  CLIENT_SCHEMA_NON_TRIGGER_STATEMENTS,
  SELECT_CLIENT_SCHEMA_TRIGGERS_SQL,
  triggerRecreateStatements,
  backfillBlockAliasesIfEmpty,
  backfillBlocksFtsIfEmpty,
  backfillBlockTypesIfEmpty,
  grandfatherWorkspaceFirstSync,
  ensureBlockUserUpdatedAtColumn,
  ensureClientSchemaStateValueColumn,
  ensureStagingNeedsApplyColumn,
  ensureUndoGroupIdColumns,
} from '@/data/internals/clientSchema'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from '@/data/localSchema.js'
import { guardSyncedTableWrites } from '@/data/syncedTableWriteGuard.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'

/** The raw sync stream lands in staging. The Repo materializes the local blocks table. */
export const createClientPowerSyncSchema = (): Schema => {
  const schema = new Schema({})
  schema.withRawTables({
    blocks_synced: BLOCKS_SYNCED_RAW_TABLE,
    workspaces: WORKSPACES_RAW_TABLE,
    workspace_members: WORKSPACE_MEMBERS_RAW_TABLE,
  })
  return schema
}

// One worker round trip for a run of parameterless statements: the adapter
// steps every statement of an unbound `execute` string, and each `execute` is
// otherwise several messages plus a lock cycle. Joined with the separator on
// its own line so a trailing line comment in a statement cannot swallow it.
// The trailing sentinel proves the LAST statement ran: an adapter that stepped
// only the first would return no row, and on an upgrading device every earlier
// statement is an IF NOT EXISTS no-op, so nothing else would notice.
// The adapter returns the FIRST column-bearing result set, so the sentinel
// proves completion only while no batched statement returns rows (no SELECT,
// PRAGMA or RETURNING in a batch).
export const BATCH_SENTINEL_SQL = 'SELECT 1 AS ok'
const runWebBatch = async (
  execute: (sql: string) => Promise<{rows?: {length: number}}>,
  statements: readonly string[],
): Promise<void> => {
  const sql = [...statements, BATCH_SENTINEL_SQL].map(stmt => stmt.trim().replace(/;+$/, '')).join('\n;\n')
  const result = await execute(sql)
  if (!result.rows?.length) {
    throw new Error('schema batch did not run to completion: the adapter executed a single statement')
  }
}
// The Node adapter prepares one SQLite statement per execute call.
const runNodeBatch: typeof runWebBatch = async (execute, statements) => {
  for (const statement of statements) await execute(statement)
}

/** The surface the client-schema initialisation needs; a structural type so a
 *  recording fake can pin the statement order. */
export type SchemaDb = Pick<CommonPowerSyncDatabase, 'execute' | 'getAll' | 'getOptional' | 'writeTransaction'>

// The client-side schema on top of PowerSync's own: tables, indexes, column
// migrations and triggers, in dependency order. Batches are bounded by the
// steps that read the schema (`ensure*`, the stale-index probe), which must
// see the preceding batch committed.
export const initializeClientSchema = async (
  db: SchemaDb,
  platform: 'web' | 'node' = 'web',
): Promise<void> => {
  const runBatch = platform === 'web' ? runWebBatch : runNodeBatch
  const runDdl = (statements: readonly string[]) => runBatch(sql => db.execute(sql), statements)

  await runDdl([
    CREATE_BLOCKS_TABLE_SQL,
    CREATE_BLOCKS_SYNCED_TABLE_SQL,
    CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
    CREATE_BLOCKS_PARENT_DELETED_INDEX_SQL,
    CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
    CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL,
  ])
  // Idempotent local migration: add the LOCAL-only derived columns
  // (`reference_target_id`) to an existing `blocks` table. MUST run before
  // the trigger recreate below — the row_events trigger bodies reference
  // the column (SQLite accepts a CREATE TRIGGER against a missing column and
  // only fails at fire time). `blocks_synced`
  // deliberately does NOT get it (never synced; docs/properties-as-blocks-migration.html §11 slice A). The
  // index is created after so it exists on upgrading devices too.
  await ensureBlockLocalColumns(db)
  await runDdl([
    CREATE_BLOCKS_BEING_EDITED_INDEX_SQL,
    CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,
    CREATE_BLOCKS_REFERENCE_CANDIDATES_INDEX_SQL,
    CREATE_BLOCKS_FIELD_FORM_INDEX_SQL,
  ])
  await dropStaleAnyFieldFormIndex(db)
  await runDdl([
    CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL,
    CREATE_WORKSPACES_TABLE_SQL,
  ])
  // Idempotent local migration: add `group_id` to an existing
  // tx_context / row_events (undo grouping, issue #306). MUST run
  // before ANY re-creation of the row_events trigger bodies — that
  // includes `withTriggerSuspended` inside `ensureBlockUserUpdatedAtColumn`
  // below (its backfill bracket re-installs blocks_row_event_update
  // from the NEW constant, whose body references group_id), not just
  // the trigger recreate at the end. Fresh DBs skip it (tables don't
  // exist yet; the CREATEs carry the column).
  await ensureUndoGroupIdColumns(db)
  // Idempotent local migration: add `user_updated_at` to an existing
  // `blocks` / `blocks_synced` on upgrading devices (CREATE TABLE IF NOT
  // EXISTS above is a no-op when the table already exists) + one-shot
  // backfill. See hydration-staleness-fix-handoff.md step 3.
  await ensureBlockUserUpdatedAtColumn(db)
  // After the migration above, not with the other blocks indexes: it is keyed
  // on `user_updated_at`, which an upgrading device does not have until then.
  await runDdl([CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL])

  // Idempotent local migration: add the E2EE columns to an existing
  // `workspaces` table on upgrading devices (CREATE TABLE IF NOT EXISTS
  // above is a no-op when the table already exists). §7 / e2ee-design.
  await ensureWorkspaceE2eeColumns(db)
  // Properties-as-blocks rollout lever (docs/properties-as-blocks-migration.html §6) — nullable; absence
  // reads as 'cell' (dormant) via parseWorkspaceRow.
  await ensureWorkspacePropertiesMigrationColumn(db)
  // workspace_members, then tx_context / row_events / command_events /
  // block_aliases / types / FTS and their indexes.
  await runDdl([
    CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
    CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
    ...CLIENT_SCHEMA_NON_TRIGGER_STATEMENTS,
  ])

  // Triggers: drop + recreate only those whose stored text differs from the
  // constant. One read on a settled database; the recreate runs in a
  // transaction so a crash can't leave a trigger dropped. Every column the
  // trigger bodies reference exists by now (the `ensure*` migrations above).
  const storedTriggers = new Map(
    (await db.getAll<{name: string; sql: string}>(SELECT_CLIENT_SCHEMA_TRIGGERS_SQL))
      .map(row => [row.name, row.sql] as const),
  )
  const triggerStatements = triggerRecreateStatements(storedTriggers)
  if (triggerStatements.length > 0) {
    await db.writeTransaction(tx => runBatch(sql => tx.execute(sql), triggerStatements))
  }
}

export const initializeClientDatabase = async (
  powerSyncDb: SchemaDb,
  platform: 'web' | 'node',
  onClientSchemaApplied?: () => void,
) => {
  await initializeClientSchema(powerSyncDb, platform)
  onClientSchemaApplied?.()

  // One-shot side-index backfills for users upgrading from a
  // pre-index schema. Steady-state startups noop on a single LIMIT 1
  // probe of `client_schema_state`.
  const backfillDb = {
    // Guarded: a LocalSchema statement/backfill that raw-writes a synced table
    // (blocks/workspaces/workspace_members) leaves tx_context.source = NULL, so
    // the upload trigger never fires and the write is local-only — it silently
    // never syncs. The guard turns that class into a loud throw. Synced-table
    // backfills must go through repo.tx (workspaceBackfillsFacet).
    execute: guardSyncedTableWrites((sql: string, params?: unknown[]) =>
      powerSyncDb.execute(sql, params as never[] | undefined)),
    getOptional: async <T,>(sql: string, params?: unknown[]) => {
      const row = await powerSyncDb.getOptional<T>(sql, params as never[] | undefined)
      return row ?? null
    },
  }
  // WITH the other one-shot backfills, not up with the CREATEs, because it is
  // one: it reads a `client_schema_state` marker, and that table is created by
  // `initializeClientSchema`. Its index follows it — on an upgrading device the ALTER and
  // seed then run against an unindexed table instead of maintaining the index
  // through every seeded row.
  await ensureStagingNeedsApplyColumn({
    ...backfillDb,
    getAll: <T,>(sql: string) => powerSyncDb.getAll<T>(sql),
  })
  // Same position, same reason: it ALTERs `client_schema_state`, which
  // `initializeClientSchema` creates.
  await ensureClientSchemaStateValueColumn(powerSyncDb)
  await powerSyncDb.execute(CREATE_BLOCKS_SYNCED_NEEDS_APPLY_INDEX_SQL)
  await backfillBlockAliasesIfEmpty(backfillDb)
  await backfillBlockTypesIfEmpty(backfillDb)
  await backfillBlocksFtsIfEmpty(backfillDb)
  await grandfatherWorkspaceFirstSync(backfillDb)
  const localSchemaContributions = resolveLocalSchemaContributions(staticDataExtensions)
  await applyLocalSchemaContributions(backfillDb, localSchemaContributions)
  return backfillDb
}
