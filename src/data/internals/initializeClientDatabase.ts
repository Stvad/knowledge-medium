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
  buildDeferredSearchIndex,
  backfillBlockTypesIfEmpty,
  grandfatherWorkspaceFirstSync,
  ensureBlockUserUpdatedAtColumn,
  ensureClientSchemaStateValueColumn,
  ensureStagingNeedsApplyColumn,
  ensureUndoGroupIdColumns,
  runAnalyzeIfStale,
} from '@/data/internals/clientSchema'
import {
  applyLocalSchemaContributions,
  installedAnalyzeArmingProbes,
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

// The web adapter returns the first result set with columns. Only the final
// sentinel may return rows, so its presence proves the whole batch ran.
export const BATCH_SENTINEL_SQL = 'SELECT 1 AS ok'
const runWebBatch = async (
  execute: (sql: string) => Promise<{rows?: {length: number}}>,
  statements: readonly string[],
): Promise<void> => {
  // A trailing SQL line comment must leave the next statement's separator intact.
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

export type SchemaDb = Pick<CommonPowerSyncDatabase, 'execute' | 'getAll' | 'getOptional' | 'writeTransaction'>

// Schema probes between batches must see the preceding DDL committed.
export const initializeClientSchema = async (
  db: SchemaDb,
  platform: 'web' | 'node',
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
  // Both the local indexes and the row_events triggers reference these columns.
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
  // The user_updated_at backfill reinstalls a row_events trigger that reads group_id.
  await ensureUndoGroupIdColumns(db)
  await ensureBlockUserUpdatedAtColumn(db)
  // An upgrading database has the recency index's user_updated_at column only now.
  await runDdl([CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL])

  await ensureWorkspaceE2eeColumns(db)
  await ensureWorkspacePropertiesMigrationColumn(db)
  await runDdl([
    CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
    CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
    ...CLIENT_SCHEMA_NON_TRIGGER_STATEMENTS,
  ])

  // Replace drifted triggers atomically after all columns they reference exist.
  const storedTriggers = new Map(
    (await db.getAll<{name: string; sql: string}>(SELECT_CLIENT_SCHEMA_TRIGGERS_SQL))
      .map(row => [row.name, row.sql] as const),
  )
  const triggerStatements = triggerRecreateStatements(storedTriggers)
  if (triggerStatements.length > 0) {
    await db.writeTransaction(tx => runBatch(sql => tx.execute(sql), triggerStatements))
  }
}

/** One planner-statistics pass (`runAnalyzeIfStale`). Logs what it analyzed
 *  and why it failed; never rejects. */
export type AnalyzeCheck = (reason: string) => Promise<void>

export type ClientDatabaseOptions = {
  /** Hands the device its {@link AnalyzeCheck} to run when a real ANALYZE —
   *  seconds on a large graph, on the one write connection — will not land on
   *  work it must not delay. Required because SQLite never builds `sqlite_stat1`
   *  itself, and without it the planner turns `blocks` joins into scans. Called
   *  once, before `initializeClientDatabase` resolves. */
  scheduleAnalyzeCheck: (check: AnalyzeCheck) => void
  onClientSchemaApplied?: () => void
}

export const initializeClientDatabase = async (
  powerSyncDb: SchemaDb,
  platform: 'web' | 'node',
  {scheduleAnalyzeCheck, onClientSchemaApplied}: ClientDatabaseOptions,
): Promise<void> => {
  await initializeClientSchema(powerSyncDb, platform)
  onClientSchemaApplied?.()

  const backfillDb = {
    // Synced-table backfills require repo.tx so their changes enter the upload queue.
    execute: guardSyncedTableWrites((sql: string, params?: unknown[]) =>
      powerSyncDb.execute(sql, params as never[] | undefined)),
    getOptional: async <T,>(sql: string, params?: unknown[]) => {
      const row = await powerSyncDb.getOptional<T>(sql, params as never[] | undefined)
      return row ?? null
    },
  }
  // The staging backfill reads a client_schema_state marker. Build its index
  // after seeding to avoid maintaining it through each row of an upgrade.
  await ensureStagingNeedsApplyColumn({
    ...backfillDb,
    getAll: <T,>(sql: string) => powerSyncDb.getAll<T>(sql),
  })
  await ensureClientSchemaStateValueColumn(powerSyncDb)
  await powerSyncDb.execute(CREATE_BLOCKS_SYNCED_NEEDS_APPLY_INDEX_SQL)
  await backfillBlockAliasesIfEmpty(backfillDb)
  await backfillBlockTypesIfEmpty(backfillDb)
  await backfillBlocksFtsIfEmpty(backfillDb)
  // Before anything can search: a process that died mid bulk load left rows
  // the index does not hold yet. Not fatal: the sync observer's first drain
  // retries it, and until then the view gap holds the gates and one-way passes.
  await buildDeferredSearchIndex(powerSyncDb).catch((error: unknown) => {
    console.error('[clientSchema] building the deferred search index failed; the sync observer retries it', error)
  })
  await grandfatherWorkspaceFirstSync(backfillDb)
  const localSchemaContributions = resolveLocalSchemaContributions(staticDataExtensions)
  await applyLocalSchemaContributions(backfillDb, localSchemaContributions)
  scheduleAnalyzeCheck(reason => runAnalyzeIfStale(
    backfillDb,
    installedAnalyzeArmingProbes(),
  ).then(({proposed, owed}) => {
    // Silent when nothing was stale. Otherwise name the tables: the log is the
    // only explanation for the pause a real ANALYZE causes.
    if (owed.length > 0) {
      console.info(`[clientSchema] ANALYZE owed by a bulk write (${reason}):`, owed.join(', '))
    }
    if (proposed && proposed.length > 0) {
      console.info(`[clientSchema] ANALYZE (${reason}):`, proposed.join(', '))
    }
  }).catch(error => {
    console.warn(`[clientSchema] ANALYZE check failed (${reason}):`, error)
  }))
}
