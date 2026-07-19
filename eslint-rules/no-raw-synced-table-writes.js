/**
 * no-raw-synced-table-writes — static half of the "raw write to a synced
 * table silently never uploads" bug class (GitHub issue #404 item 1). See
 * `src/data/syncedTableWriteGuard.ts` for the full writeup and the runtime
 * guard (wired only to the bootstrap backfill handle).
 *
 * Uploads from the local SQLite DB to the server are driven by the
 * `blocks_upload_*` triggers, gated `WHEN (SELECT source FROM tx_context) IS
 * NOT NULL`. `tx_context.source` is set ONLY by a `repo.tx(...)` write. A raw
 * `db.execute('UPDATE blocks …')` from outside a tx leaves `source = NULL`,
 * so the upload trigger never fires and the row lands LOCAL-ONLY — it
 * silently never reaches the server or any other client. `workspaces` /
 * `workspace_members` are PowerSync raw tables with the same property —
 * out-of-band local writes don't propagate either.
 *
 * This rule flags any string / template literal in `src/` whose SQL writes
 * (INSERT/UPDATE/DELETE) to `blocks`, `workspaces`, or `workspace_members`,
 * so a new raw-write regression fails lint instead of failing silently at
 * sync time. Detection mirrors `writeTargetTable` in
 * syncedTableWriteGuard.ts: only the WRITE TARGET (the table right after
 * `INTO` / `UPDATE` / `DELETE FROM`) counts, so e.g.
 * `INSERT INTO block_aliases … SELECT … FROM blocks` is correctly attributed
 * to `block_aliases`, not `blocks`; and local tables that merely share a
 * name prefix (`blocks_synced`, `blocks_fts`, `blocks_synced_changes`, …) are
 * exact-name matched and so never flagged.
 *
 * A dynamic write target (e.g. `` `INSERT INTO ${tableName} (…)` ``) can't be
 * resolved statically — the interpolation is dropped rather than guessed at,
 * so the regex correctly fails to capture a table name and the site isn't
 * flagged. That's a known limitation of a literal-text rule, not something
 * this rule tries to work around.
 *
 * A small handful of files are legitimately exempt (the tx write path
 * itself, the sync arrival path, one-time schema migrations, local
 * derived-column writes in repo.ts, tests) — see the `files`-scoped
 * overrides in eslint.config.js, each with a comment explaining why.
 */

/** App-visible / synced tables whose changes must propagate through the
 *  upload path. Exact names: `blocks_fts`, `blocks_synced`, `block_aliases`,
 *  etc. are deliberately NOT here — they are local. Kept in sync with the
 *  runtime guard's list in syncedTableWriteGuard.ts. */
const SYNCED_TABLES = new Set(['blocks', 'workspaces', 'workspace_members'])

/** Strip a leading run of `--` line comments, block comments, and whitespace
 *  so the verb match below sees the real first token. */
const stripLeading = (sql) => {
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
const unquote = (ident) => ident.replace(/^["'`[]/, '').replace(/["'`\]]$/, '')

/**
 * The bare table name of a possibly schema-qualified, possibly quoted table
 * reference: `main.blocks`, `"main"."blocks"`, `[main].[blocks]` → `blocks`.
 * SQLite accepts a schema prefix on a DML target, and `UPDATE main.blocks`
 * writes the very same synced table — an exact-name check against the raw
 * capture let it through (PR #386 review). A dot INSIDE a quoted identifier
 * doesn't split, so a (pathological) table literally named `"a.b"` still
 * resolves to `a.b` rather than `b`.
 *
 * Deliberately over-approximates: a write to `temp.blocks` — a different
 * table in the temp schema — would also read as `blocks`. No such table
 * exists in this schema, and a guard that occasionally asks for an explicit
 * override is the right side to err on.
 */
const unqualifiedTableName = (ref) => {
  const parts = []
  let current = ''
  let quote = null
  for (const ch of ref) {
    if (quote !== null) {
      current += ch
      if (ch === quote || (quote === '[' && ch === ']')) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`' || ch === '[') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '.') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return unquote(parts[parts.length - 1]).toLowerCase()
}

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
 * `isUnresolvableStatement` in syncedTableWriteGuard.ts.
 */
const skipCtePrefix = (s) => {
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
 * Split a script into its top-level statements, ignoring semicolons inside
 * string/identifier literals, comments, and parentheses.
 *
 * `applyLocalSchemaContributions` runs `db.execute(statement)` with no params,
 * and the adapter executes EVERY statement in the string when there are no
 * bindings — so `CREATE INDEX …; UPDATE blocks SET …` runs both halves while a
 * first-statement-only check sees a harmless CREATE (PR #386 review). Nothing
 * ships a two-statement string today; the guard exists for the regression that
 * hasn't been written yet, so a hole in it is the thing worth closing.
 *
 * A `CREATE TRIGGER … BEGIN UPDATE blocks …; END` body splits into fragments
 * too, harmlessly: the verb match only fires at a fragment's START, and the
 * trigger's own fragment starts with CREATE.
 */
const splitTopLevelStatements = (sql) => {
  const statements = []
  let current = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote !== null) {
      current += ch
      if (quote === '[') {
        if (ch === ']') quote = null
      } else if (ch === quote) {
        if (sql[i + 1] === quote) { current += sql[++i]; continue }
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      current += sql.slice(i, end)
      i = end - 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i)
      const end = close === -1 ? sql.length : close + 2
      current += sql.slice(i, end)
      i = end - 1
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth === 0) {
      statements.push(current)
      current = ''
      continue
    }
    current += ch
  }
  statements.push(current)
  return statements.filter(s => s.trim() !== '')
}

/**
 * The table an INSERT / UPDATE / DELETE writes to, lowercased, or `null` for
 * any other statement (SELECT, CREATE INDEX/TRIGGER, DROP, PRAGMA, …) or an
 * unresolvable dynamic target. Mirrors `writeTargetTable` in
 * syncedTableWriteGuard.ts, including its WITH-prefix handling.
 */
const writeTargetTable = (sql) => {
  const s = skipCtePrefix(stripLeading(sql))
  const insert = s.match(/^(?:insert(?:\s+or\s+\w+)?|replace)\s+into\s+([^\s(]+)/i)
  if (insert) return unqualifiedTableName(insert[1])
  const update = s.match(/^update\s+(?:or\s+\w+\s+)?([^\s(]+)/i)
  if (update) return unqualifiedTableName(update[1])
  const del = s.match(/^delete\s+from\s+([^\s(]+)/i)
  if (del) return unqualifiedTableName(del[1])
  return null
}

/** The static text a literal AST node contributes, for target-table matching
 *  only. A template literal's interpolated expressions are dropped (not
 *  substituted) — see the module doc comment on why that's the right call,
 *  not a gap to paper over. */
const literalSqlText = (node) => {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null
  if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.raw).join('')
  return null
}

const noRawSyncedTableWrites = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag raw SQL writes (INSERT/UPDATE/DELETE) to synced tables (blocks, workspaces, workspace_members) outside repo.tx.',
    },
    schema: [],
    messages: {
      rawSyncedWrite:
        'Raw SQL write to synced table "{{table}}". Only a repo.tx(...) write sets '
        + 'tx_context.source, and the upload trigger is gated on that being non-NULL — a '
        + 'raw write here leaves source = NULL, so the upload trigger never fires and the '
        + 'row is silently local-only (see src/data/syncedTableWriteGuard.ts). It also '
        + 'skips the kernel derivations the pipeline runs (block_types, reference '
        + 'normalization, property projection), so derived state desyncs too. Route this '
        + 'write through repo.tx instead.',
      // Deliberately different advice: these two have no upload trigger at all,
      // so "route it through repo.tx" is not a fix that exists. Server state
      // for them changes via the Supabase RPCs and comes back through sync.
      rawWorkspaceWrite:
        'Raw SQL write to "{{table}}". This table has no upload path — the local row is '
        + 'a replica: server state changes through the workspace Supabase RPCs and '
        + 'arrives via PowerSync. A write here is local-only priming that the next sync '
        + 'replay overwrites, so it must be a deliberate, documented pre-sync prime '
        + '(see primeLocalWorkspace in src/data/workspaces.ts) — never the way to '
        + 'change workspace state.',
    },
  },
  create(context) {
    const check = (node) => {
      const text = literalSqlText(node)
      if (text === null) return
      const table = splitTopLevelStatements(text)
        .map(writeTargetTable)
        .find(t => t !== null && SYNCED_TABLES.has(t))
      if (table !== undefined) {
        const messageId = table === 'blocks' ? 'rawSyncedWrite' : 'rawWorkspaceWrite'
        context.report({node, messageId, data: {table}})
      }
    }
    return {
      Literal: check,
      TemplateLiteral: check,
    }
  },
}

export default {
  rules: {
    'no-raw-synced-table-writes': noRawSyncedTableWrites,
  },
}
