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
 * The table an INSERT / UPDATE / DELETE writes to, lowercased, or `null` for
 * any other statement (SELECT, CREATE INDEX/TRIGGER, DROP, PRAGMA, …) or an
 * unresolvable dynamic target. Mirrors `writeTargetTable` in
 * syncedTableWriteGuard.ts.
 */
const writeTargetTable = (sql) => {
  const s = stripLeading(sql)
  const insert = s.match(/^(?:insert(?:\s+or\s+\w+)?|replace)\s+into\s+([^\s(]+)/i)
  if (insert) return unquote(insert[1]).toLowerCase()
  const update = s.match(/^update\s+(?:or\s+\w+\s+)?([^\s(]+)/i)
  if (update) return unquote(update[1]).toLowerCase()
  const del = s.match(/^delete\s+from\s+([^\s(]+)/i)
  if (del) return unquote(del[1]).toLowerCase()
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
      const table = writeTargetTable(text)
      if (table !== null && SYNCED_TABLES.has(table)) {
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
