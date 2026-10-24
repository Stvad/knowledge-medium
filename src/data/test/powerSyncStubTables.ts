/** The PowerSync-owned table the client-schema triggers write, for
 *  `node:sqlite` harnesses that run `CLIENT_SCHEMA_STATEMENTS` without the
 *  PowerSync core: the upload queue. Only the columns the triggers touch. */
export const POWERSYNC_STUB_TABLES_SQL: readonly string[] = [
  `CREATE TABLE ps_crud (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    tx_id INTEGER
  )`,
]
