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
 */

/** App-visible / synced tables whose changes must propagate through the upload
 *  path. These are exact names: `blocks_fts`, `blocks_synced`, `block_aliases`,
 *  etc. are deliberately NOT here — they are local.
 *
 *  Exported so other callers that need the same "is this a synced table"
 *  check (e.g. the agent bridge's raw `sql` verb) share this single list
 *  instead of re-deriving it. */
export const SYNCED_TABLES: ReadonlySet<string> = new Set([
  'blocks',
  'workspaces',
  'workspace_members',
])

/** Strip a leading run of `--` line comments, block comments, and whitespace
 *  so the verb match below sees the real first token. */
const stripLeading = (sql: string): string => {
  let s = sql.trimStart()
  for (;;) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n')
      s = nl === -1 ? '' : s.slice(nl + 1).trimStart()
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/')
      s = end === -1 ? '' : s.slice(end + 2).trimStart()
    } else {
      return s
    }
  }
}

/** Strip one layer of identifier quoting: "x", `x`, [x], 'x'. */
const unquote = (ident: string): string =>
  ident.replace(/^["'`[]/, '').replace(/["'`\]]$/, '')

/**
 * The table an INSERT / UPDATE / DELETE writes to, lowercased, or `null` for
 * any other statement (SELECT, CREATE INDEX/TRIGGER, DROP, PRAGMA, …). Reads
 * the *write target* — the table after `INTO` / `UPDATE` / `DELETE FROM` — so a
 * statement that only mentions a synced table in a `FROM`/subquery (e.g. a
 * local-index backfill `INSERT INTO block_aliases … SELECT … FROM blocks`) is
 * correctly attributed to its real target.
 */
export const writeTargetTable = (sql: string): string | null => {
  const s = stripLeading(sql)
  const insert = s.match(/^(?:insert(?:\s+or\s+\w+)?|replace)\s+into\s+([^\s(]+)/i)
  if (insert) return unquote(insert[1]).toLowerCase()
  const update = s.match(/^update\s+(?:or\s+\w+\s+)?([^\s(]+)/i)
  if (update) return unquote(update[1]).toLowerCase()
  const del = s.match(/^delete\s+from\s+([^\s(]+)/i)
  if (del) return unquote(del[1]).toLowerCase()
  return null
}

type ExecuteFn<A extends unknown[], R> = (sql: string, ...rest: A) => Promise<R>

/** Wrap an `execute` so a write to a synced table rejects instead of running. */
export const guardSyncedTableWrites = <A extends unknown[], R>(
  execute: ExecuteFn<A, R>,
): ExecuteFn<A, R> =>
  (sql, ...rest) => {
    const target = writeTargetTable(sql)
    if (target !== null && SYNCED_TABLES.has(target)) {
      return Promise.reject(
        new Error(
          `[syncedTableWriteGuard] refusing a raw write to synced table "${target}". ` +
            'Backfill / local-schema writes to blocks/workspaces/workspace_members leave ' +
            'tx_context.source = NULL, so the upload trigger never fires and the write is ' +
            'local-only — it will silently never sync (see the daily-note:date backfill, ' +
            'gone in 8c50f167). Route synced-table backfills through repo.tx — e.g. ' +
            `workspaceBackfillsFacet — which uploads. Offending SQL: ${sql.trim().slice(0, 120)}`,
        ),
      )
    }
    return execute(sql, ...rest)
  }
