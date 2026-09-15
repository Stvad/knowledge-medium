// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  BLOCK_LOCAL_COLUMNS,
  CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL,
  CREATE_BLOCKS_PARENT_DELETED_INDEX_SQL,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_REFERENCE_CANDIDATES_INDEX_SQL,
  CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,
  CREATE_BLOCKS_FIELD_FORM_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CLIENT_SCHEMA_NON_TRIGGER_STATEMENTS,
  CLIENT_SCHEMA_TRIGGER_CREATE_SQL,
  SELECT_CLIENT_SCHEMA_TRIGGERS_SQL,
} from '@/data/internals/clientSchema'
import {
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
  CREATE_WORKSPACES_TABLE_SQL,
} from '@/data/workspaceSchema'
import { BATCH_SENTINEL_SQL, initializeClientSchema, type SchemaDb } from '@/data/repoProvider'

// A recording fake standing in for PowerSync: the point is the ORDER of the
// statement batches relative to the reads that gate them, and the completion
// sentinel — neither is observable on a real database, where the same
// statements land whichever way they are batched.
type Call = {kind: 'execute' | 'getAll' | 'getOptional' | 'tx'; sql: string}

// Every column the `ensure*` migrations look for, so they report "present"
// and issue no ALTERs of their own.
const PRESENT_COLUMNS = [
  ...BLOCK_LOCAL_COLUMNS.map(column => column.name),
  'user_updated_at', 'group_id', 'encryption_mode', 'wk_canary', 'properties_migration',
].map(name => ({name}))

const fakeDb = (opts: {sentinelRows?: number; storedTriggers?: ReadonlyMap<string, string>} = {}) => {
  const calls: Call[] = []
  const stored = opts.storedTriggers ?? CLIENT_SCHEMA_TRIGGER_CREATE_SQL
  const result = (sql: string) => ({
    rows: {length: sql.trimEnd().endsWith(BATCH_SENTINEL_SQL) ? opts.sentinelRows ?? 1 : 0},
  })
  const db = {
    execute: async (sql: string) => {
      calls.push({kind: 'execute', sql})
      return result(sql)
    },
    getAll: async (sql: string) => {
      calls.push({kind: 'getAll', sql})
      if (sql === SELECT_CLIENT_SCHEMA_TRIGGERS_SQL) return [...stored].map(([name, text]) => ({name, sql: text}))
      if (sql.startsWith('PRAGMA table_info(')) return PRESENT_COLUMNS
      return []
    },
    getOptional: async (sql: string) => {
      calls.push({kind: 'getOptional', sql})
      return null
    },
    writeTransaction: async (fn: (tx: {execute: (sql: string) => Promise<unknown>}) => Promise<unknown>) =>
      fn({
        execute: async (sql: string) => {
          calls.push({kind: 'tx', sql})
          return result(sql)
        },
      }),
  } as unknown as SchemaDb
  return {db, calls}
}

const batches = (calls: Call[]) =>
  calls.filter(c => c.kind === 'execute').map(c => c.sql.split('\n;\n').map(stmt => stmt.trim()))
const batchIndexOf = (calls: Call[], statement: string) =>
  calls.findIndex(c => c.kind === 'execute' && c.sql.includes(statement.trim().replace(/;+$/, '')))
const readIndexOf = (calls: Call[], sql: string) => calls.findIndex(c => c.kind !== 'execute' && c.sql === sql)

const norm = (sql: string) => sql.trim().replace(/;+$/, '')

describe('initializeClientSchema', () => {
  it('runs every DDL statement, in batches that each end with the completion sentinel', async () => {
    const {db, calls} = fakeDb()
    await initializeClientSchema(db)
    const all = batches(calls)
    for (const batch of all) expect(batch.at(-1)).toBe(BATCH_SENTINEL_SQL)
    const executed = new Set(all.flat())
    for (const statement of [
      CREATE_BLOCKS_TABLE_SQL,
      CREATE_BLOCKS_SYNCED_TABLE_SQL,
      CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
      CREATE_BLOCKS_PARENT_DELETED_INDEX_SQL,
      CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL,
      CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL,
      CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,
      CREATE_BLOCKS_REFERENCE_CANDIDATES_INDEX_SQL,
      CREATE_BLOCKS_FIELD_FORM_INDEX_SQL,
      CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL,
      CREATE_WORKSPACES_TABLE_SQL,
      CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
      CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
      ...CLIENT_SCHEMA_NON_TRIGGER_STATEMENTS,
    ]) {
      expect(executed.has(norm(statement)), statement.slice(0, 60)).toBe(true)
    }
  })

  it('orders each batch after the schema read that gates it', async () => {
    const {db, calls} = fakeDb()
    await initializeClientSchema(db)
    // The local-column migration reads `blocks`, which the first batch creates,
    // and the indexes over those columns come after the migration.
    const blocksTable = batchIndexOf(calls, CREATE_BLOCKS_TABLE_SQL)
    const blocksColumns = readIndexOf(calls, 'PRAGMA table_info(blocks)')
    const localIndexes = batchIndexOf(calls, CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL)
    expect(blocksTable).toBeLessThan(blocksColumns)
    expect(blocksColumns).toBeLessThan(localIndexes)
    // The recency index is keyed on `user_updated_at`, so it must come after
    // the migration that adds that column — on an upgrading device it does not
    // exist before, and CREATE INDEX over a missing column fails outright.
    // Anchored on the `blocks_synced` read because the `blocks` one is also
    // taken by the earlier local-column migration.
    const userUpdatedAtColumns = readIndexOf(calls, 'PRAGMA table_info(blocks_synced)')
    expect(userUpdatedAtColumns).toBeGreaterThan(-1)
    expect(userUpdatedAtColumns)
      .toBeLessThan(batchIndexOf(calls, CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL))
    // The stale-index probe precedes the any-field-form index it replaces.
    const staleProbe = calls.findIndex(c => c.kind === 'getOptional' && c.sql.includes('idx_blocks_any_field_form'))
    expect(staleProbe).toBeLessThan(batchIndexOf(calls, CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL))
    // The workspaces column migrations read the table the batch before creates.
    const workspacesTable = batchIndexOf(calls, CREATE_WORKSPACES_TABLE_SQL)
    const workspacesColumns = readIndexOf(calls, 'PRAGMA table_info(workspaces)')
    expect(workspacesTable).toBeLessThan(workspacesColumns)
    expect(workspacesColumns).toBeLessThan(batchIndexOf(calls, CREATE_WORKSPACE_MEMBERS_TABLE_SQL))
    // The row_events group_id migration runs before any trigger body that
    // references the column could be (re)created.
    const groupIdColumns = readIndexOf(calls, 'PRAGMA table_info(row_events)')
    const triggerRead = readIndexOf(calls, SELECT_CLIENT_SCHEMA_TRIGGERS_SQL)
    expect(groupIdColumns).toBeGreaterThan(-1)
    expect(groupIdColumns).toBeLessThan(triggerRead)
  })

  it('leaves triggers alone when sqlite_master matches, and recreates only a drifted one in a transaction', async () => {
    const settled = fakeDb()
    await initializeClientSchema(settled.db)
    expect(settled.calls.filter(c => c.kind === 'tx')).toEqual([])
    expect(settled.calls.some(c => c.sql.includes('DROP TRIGGER'))).toBe(false)

    const [name, createSql] = [...CLIENT_SCHEMA_TRIGGER_CREATE_SQL][0]
    const drifted = new Map(CLIENT_SCHEMA_TRIGGER_CREATE_SQL)
    drifted.set(name, createSql.replace('BEGIN', 'BEGIN SELECT 1;'))
    const {db, calls} = fakeDb({storedTriggers: drifted})
    await initializeClientSchema(db)
    const tx = calls.filter(c => c.kind === 'tx')
    expect(tx).toHaveLength(1)
    const statements = tx[0].sql.split('\n;\n').map(stmt => stmt.trim())
    expect(statements).toEqual([`DROP TRIGGER IF EXISTS ${name}`, norm(createSql), BATCH_SENTINEL_SQL])
  })

  it('throws when a batch returns no sentinel row', async () => {
    const {db} = fakeDb({sentinelRows: 0})
    await expect(initializeClientSchema(db)).rejects.toThrow(/did not run to completion/)
  })
})
