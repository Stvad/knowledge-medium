/** Shared node:sqlite harness for the row_events v2 test files
 *  (rowEventsV2.test.ts, rowEventsV2.fuzz.test.ts).
 *
 *  Same SQLite C library as wa-sqlite, so trigger semantics match the
 *  browser; the sync API keeps tests legible and fast. Mirrors the
 *  production bootstrap shape: blocks + staging + workspace_members +
 *  the CLIENT_SCHEMA_STATEMENTS loop (fresh CREATE carries the v2
 *  columns, so no ALTER migration is needed here). */

import {DatabaseSync} from 'node:sqlite'
import {
  BLOCK_STORAGE_COLUMNS,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_TABLE_SQL,
} from '@/data/blockSchema'
import {CREATE_WORKSPACE_MEMBERS_TABLE_SQL} from '@/data/workspaceSchema'
import {
  CLIENT_SCHEMA_STATEMENTS,
  CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,
  buildBlocksUpdateRowEventTriggerSql,
} from '../clientSchema'
import type {RowEventsHistoryDb} from '../rowEventsHistory'

/** The 13 domain keys of a full snapshot payload. Deliberately a
 *  hand-written test-side copy, NOT derived from ROW_EVENT_COLUMNS —
 *  deriving the expectation from the production spec would make every
 *  "full snapshot has all keys" assertion tautological. */
export const DOMAIN_KEYS = [
  'id', 'workspaceId', 'parentId', 'orderKey', 'content', 'properties', 'references',
  'createdAt', 'updatedAt', 'userUpdatedAt', 'createdBy', 'updatedBy', 'deleted',
] as const

export interface BlockInsert {
  id: string
  workspace_id: string
  parent_id: string | null
  order_key: string
  content: string
  properties_json: string
  references_json: string
  created_at: number
  updated_at: number
  user_updated_at: number | null
  created_by: string
  updated_by: string
  deleted: 0 | 1
}

export const defaultBlock: BlockInsert = {
  id: 'b1',
  workspace_id: 'ws1',
  parent_id: null,
  order_key: 'a0',
  content: 'hello',
  properties_json: '{}',
  references_json: '[]',
  created_at: 1700000000000,
  updated_at: 1700000000000,
  user_updated_at: 1700000000000,
  created_by: 'u1',
  updated_by: 'u1',
  deleted: 0,
}

/** Async adapter over the sync node:sqlite handle, shaped for stateAt. */
export const historyDb = (db: DatabaseSync): RowEventsHistoryDb => ({
  getAll: <T,>(sql: string, params: unknown[] = []) =>
    Promise.resolve(db.prepare(sql).all(...(params as (string | number)[])) as T[]),
})

export interface RowEventsTestDb {
  db: DatabaseSync
  history: RowEventsHistoryDb
  insertBlock: (overrides?: Partial<BlockInsert>) => void
  updateBlock: (id: string, set: Record<string, string | number | null>) => void
  /** Swap the update-trigger body for a deterministic-coin variant
   *  (ANCHOR_COIN_ALWAYS_SQL / ANCHOR_COIN_NEVER_SQL), or back to the
   *  production random coin when called with no argument. */
  installUpdateTrigger: (coinSql?: string) => void
  /** Run `fn` with all three row_events triggers dropped (simulating an
   *  unlogged gap), then reinstall them. Pass `reinstallCoinSql` (e.g.
   *  ANCHOR_COIN_NEVER_SQL) to reinstall the update body with a
   *  deterministic coin; default is the production random coin. */
  suspendRowEventTriggers: (fn: () => void, reinstallCoinSql?: string) => void
  close: () => void
}

export const setupRowEventsDb = (): RowEventsTestDb => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE ps_crud (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, tx_id INTEGER)')
  db.exec(CREATE_BLOCKS_TABLE_SQL)
  db.exec(CREATE_BLOCKS_SYNCED_TABLE_SQL)
  db.exec(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) db.exec(stmt)

  const names = BLOCK_STORAGE_COLUMNS.map(c => c.name)
  const insertStmt = db.prepare(
    `INSERT INTO blocks (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
  )

  const installUpdateTrigger = (coinSql?: string) => {
    db.exec('DROP TRIGGER IF EXISTS blocks_row_event_update')
    db.exec(coinSql === undefined
      ? CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL
      : buildBlocksUpdateRowEventTriggerSql(coinSql))
  }

  return {
    db,
    history: historyDb(db),
    insertBlock: (overrides = {}) => {
      const row = {...defaultBlock, ...overrides}
      insertStmt.run(...names.map(n => row[n]))
    },
    updateBlock: (id, set) => {
      const cols = Object.keys(set)
      db.prepare(`UPDATE blocks SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map(c => set[c]), id)
    },
    installUpdateTrigger,
    suspendRowEventTriggers: (fn, reinstallCoinSql) => {
      db.exec('DROP TRIGGER IF EXISTS blocks_row_event_insert')
      db.exec('DROP TRIGGER IF EXISTS blocks_row_event_update')
      db.exec('DROP TRIGGER IF EXISTS blocks_row_event_delete')
      try {
        fn()
      } finally {
        db.exec(CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL)
        installUpdateTrigger(reinstallCoinSql)
        db.exec(CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL)
      }
    },
    close: () => db.close(),
  }
}
