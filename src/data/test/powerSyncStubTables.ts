/** The PowerSync-owned tables the client-schema triggers write, for
 *  `node:sqlite` harnesses that run `CLIENT_SCHEMA_STATEMENTS` without the
 *  PowerSync core: the upload queue, and the bucket table whose `$local` row
 *  holds downloads back. Only the columns the triggers touch; `name` is unique
 *  as in the core's own schema, which the triggers' `INSERT OR REPLACE`
 *  relies on. */
export const POWERSYNC_STUB_TABLES_SQL: readonly string[] = [
  `CREATE TABLE ps_crud (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    tx_id INTEGER
  )`,
  `CREATE TABLE ps_buckets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    last_op INTEGER NOT NULL DEFAULT 0,
    target_op INTEGER NOT NULL DEFAULT 0
  )`,
]
