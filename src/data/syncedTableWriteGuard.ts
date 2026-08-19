/**
 * Guardrail for the "raw write to a synced table silently never uploads" bug
 * class — the failure that stranded the `daily-note:date` backfill (added
 * 2026-05-18, removed in `8c50f167`).
 *
 * Uploads from the local SQLite DB to the server are driven by the
 * `blocks_upload_*` triggers, gated `WHEN (SELECT source FROM tx_context) IS
 * NOT NULL`. `tx_context.source` is set ONLY by a `repo.tx(...)` write. A raw
 * `db.execute('UPDATE blocks …')` from a LocalSchema statement/backfill leaves
 * `source = NULL`, so the trigger never fires and the row lands LOCAL-ONLY: it
 * silently never reaches the server or any other client. `workspaces` /
 * `workspace_members` are PowerSync raw tables with the same property —
 * out-of-band local writes don't propagate either.
 *
 * Rule: LocalSchema statements/backfills may READ any table and may WRITE to
 * local derived-index tables (block_aliases, block_types, blocks_fts*,
 * block_references, client_schema_state, …), but must NEVER INSERT/UPDATE/DELETE
 * a synced table. A synced-table backfill belongs in a `repo.tx` (e.g. via
 * `workspaceBackfillsFacet`), which carries `source = 'user'` and uploads.
 *
 * `guardSyncedTableWrites` wraps a backfill `execute` so the forbidden shape
 * throws immediately — in dev, CI, and prod — instead of failing silently at
 * sync time. (It never fires for the current backfills, which all target local
 * tables; it only bites a newly-introduced regression.)
 *
 * The recognizer that decides "does this SQL write a synced table" — and the
 * design rationale behind it (why it's position-independent, the single-quote
 * second pass, the destructive-DDL narrowing) — lives in
 * `syncedTableSqlRecognizer.js`, shared as-is with the static half of this
 * bug class, `eslint-rules/no-raw-synced-table-writes.js`. See that file's
 * module doc for the algorithm.
 */

export { SYNCED_TABLES, writeTargets, syncedWriteTarget } from './syncedTableSqlRecognizer.js'
import { syncedWriteTarget } from './syncedTableSqlRecognizer.js'

type ExecuteFn<A extends unknown[], R> = (sql: string, ...rest: A) => Promise<R>

/** Wrap an `execute` so a write to a synced table rejects instead of running. */
export const guardSyncedTableWrites = <A extends unknown[], R>(
  execute: ExecuteFn<A, R>,
): ExecuteFn<A, R> =>
  (sql, ...rest) => {
    const target = syncedWriteTarget(sql)
    if (target !== null) {
      return Promise.reject(
        new Error(
          `[syncedTableWriteGuard] refusing a raw write to synced table "${target}". ` +
            'Backfill / local-schema writes to blocks/workspaces/workspace_members leave ' +
            'tx_context.source = NULL, so the upload trigger never fires and the write is ' +
            'local-only — it will silently never sync (see the daily-note:date backfill, ' +
            'gone in 8c50f167). Route synced-table backfills through repo.tx — e.g. ' +
            'workspaceBackfillsFacet — which uploads. If this is destructive DDL ' +
            '(DROP TABLE / ALTER … RENAME / ALTER … DROP COLUMN), it is refused for a ' +
            'different reason: it would discard synced state the server still holds, and ' +
            'belongs in a migration rather than an ad-hoc execute. Additive DDL ' +
            `(ALTER … ADD COLUMN) and trigger/index maintenance are allowed. Offending SQL: ${sql.trim().slice(0, 120)}`,
        ),
      )
    }
    return execute(sql, ...rest)
  }
