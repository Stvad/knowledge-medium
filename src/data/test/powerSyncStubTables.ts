/** The PowerSync-owned tables the client-schema triggers write, for
 *  `node:sqlite` harnesses that run `CLIENT_SCHEMA_STATEMENTS` without the
 *  PowerSync core: the upload queue, and the key-value table whose checkpoint
 *  keys an enqueue clears. Only the columns the triggers touch. */
export const POWERSYNC_STUB_TABLES_SQL: readonly string[] = [
  `CREATE TABLE ps_crud (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    tx_id INTEGER
  )`,
  `CREATE TABLE ps_kv (key TEXT PRIMARY KEY NOT NULL, value BLOB)`,
]
