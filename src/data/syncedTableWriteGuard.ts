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
 * Skip a leading `WITH [RECURSIVE] cte AS (…), … ` prefix and return the
 * statement it decorates, or the input unchanged when there is no such prefix.
 *
 * SQLite lets a WITH clause prefix INSERT / UPDATE / DELETE, not just SELECT
 * (https://sqlite.org/lang_with.html), so `WITH ids AS (…) UPDATE blocks …` is
 * a real synced-table write whose first token is `WITH` — it slipped past the
 * verb match below and was waved through by every consumer of this function
 * (PR #386 review). Every CTE body is parenthesized, so the statement's own
 * verb is simply the first keyword at paren depth 0.
 *
 * The scan skips string/identifier literals and comments rather than counting
 * parens blindly: a `'('` inside a CTE body would otherwise unbalance the
 * depth and hide the write. Anything it can't resolve returns null from
 * `writeTargetTable`, same as a SELECT — callers that must fail closed check
 * {@link isUnresolvableStatement}.
 */
const skipCtePrefix = (s: string): string => {
  if (!/^with\b/i.test(s)) return s
  let depth = 0
  for (let i = 4; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      // Quoted literal/identifier: skip to its close, honouring '' escaping.
      let j = i + 1
      while (j < s.length) {
        if (s[j] === c) {
          if (s[j + 1] === c) { j += 2; continue }
          break
        }
        j++
      }
      i = j
    } else if (c === '[') {
      const end = s.indexOf(']', i)
      i = end === -1 ? s.length : end
    } else if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i)
      i = nl === -1 ? s.length : nl
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i)
      i = end === -1 ? s.length : end + 1
    } else if (c === '(') {
      depth++
    } else if (c === ')') {
      depth--
    } else if (depth === 0 && /[a-z]/i.test(c)) {
      const rest = s.slice(i)
      // The main statement's verb — everything before it is CTE scaffolding
      // (names, AS, MATERIALIZED, commas). A CTE *named* e.g. `updates` can't
      // false-match: `\b` requires the keyword to end at a non-word char.
      if (/^(?:insert\b|replace\b|update\b|delete\b|select\b|values\b)/i.test(rest)) {
        return rest
      }
      // Skip the rest of this identifier so its interior can't match.
      while (i + 1 < s.length && /[\w$]/.test(s[i + 1])) i++
    }
  }
  return s
}

/**
 * The table an INSERT / UPDATE / DELETE writes to, lowercased, or `null` for
 * any other statement (SELECT, CREATE INDEX/TRIGGER, DROP, PRAGMA, …). Reads
 * the *write target* — the table after `INTO` / `UPDATE` / `DELETE FROM` — so a
 * statement that only mentions a synced table in a `FROM`/subquery (e.g. a
 * local-index backfill `INSERT INTO block_aliases … SELECT … FROM blocks`) is
 * correctly attributed to its real target. A leading WITH clause is skipped
 * first (see {@link skipCtePrefix}), so a CTE-prefixed DML statement resolves
 * to the table it actually writes.
 */
export const writeTargetTable = (sql: string): string | null => {
  const s = skipCtePrefix(stripLeading(sql))
  const insert = s.match(/^(?:insert(?:\s+or\s+\w+)?|replace)\s+into\s+([^\s(]+)/i)
  if (insert) return unquote(insert[1]).toLowerCase()
  const update = s.match(/^update\s+(?:or\s+\w+\s+)?([^\s(]+)/i)
  if (update) return unquote(update[1]).toLowerCase()
  const del = s.match(/^delete\s+from\s+([^\s(]+)/i)
  if (del) return unquote(del[1]).toLowerCase()
  return null
}

/**
 * True when the statement carries a WITH prefix whose main verb we could NOT
 * find — malformed, or a shape the scan doesn't model. `writeTargetTable`
 * reports null for it, which reads as "not a write" and is the WRONG default
 * for a guard. Callers that must fail closed (the agent bridge's raw `sql`
 * verb) refuse these unless explicitly overridden; a well-formed
 * `WITH … SELECT` resolves normally and is unaffected, so ordinary recursive-
 * CTE reads still work.
 */
export const isUnresolvableStatement = (sql: string): boolean => {
  const s = stripLeading(sql)
  return /^with\b/i.test(s) && /^with\b/i.test(skipCtePrefix(s))
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
