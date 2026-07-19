/**
 * no-raw-synced-table-writes — static half of the "raw write to a synced
 * table silently never uploads" bug class (GitHub issue #404 item 1). See
 * `src/data/syncedTableWriteGuard.ts` for the full writeup, the runtime guard,
 * and — importantly — the reasoning behind the recognizer below, which this
 * file MIRRORS rather than imports (ESLint loads rule files untranspiled, and
 * the app tsconfigs don't enable `allowJs`, so neither side can import the
 * other).
 *
 * `src/test/syncedTableSqlParserParity.test.ts` runs both copies over one
 * corpus and fails if they ever disagree — that test is what keeps this
 * duplication honest, so update both sides together.
 *
 * The rule flags any string / template literal in `src/` whose SQL writes to
 * `blocks`, `workspaces`, or `workspace_members`, so a new raw-write
 * regression fails lint instead of failing silently at sync time.
 *
 * A dynamic write target (e.g. `` `INSERT INTO ${tableName} (…)` ``) can't be
 * resolved statically — the interpolation is dropped rather than guessed at,
 * so the site isn't flagged. Known limitation of a literal-text rule.
 *
 * A small handful of files are legitimately exempt — see the `files`-scoped
 * overrides in eslint.config.js, each with a comment explaining why.
 */

/** Mirrors `SYNCED_TABLES` in syncedTableWriteGuard.ts. */
const SYNCED_TABLES = new Set(['blocks', 'workspaces', 'workspace_members'])

/**
 * Replace comments and single-quoted string literals with equivalent-length
 * runs of spaces, so the scan below sees SQL structure only.
 *
 * Comments become whitespace because that is what they are to SQLite — which
 * is what makes `UPDATE /* note *\/ blocks SET …` a real write that a
 * `\s+`-joined pattern missed. String literals are blanked so prose can't fake
 * a match (`INSERT INTO log VALUES ('update blocks now')`); a write can never
 * hide INSIDE a literal, so blanking them loses nothing.
 *
 * Double-quoted / backtick / bracket identifiers are KEPT — `UPDATE "blocks"`
 * is a real write and the quoted name is the target.
 */
const blankCommentsAndStrings = (sql) => {
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      out += ' '.repeat(end - i)
      i = end - 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i)
      const end = close === -1 ? sql.length : close + 2
      out += ' '.repeat(end - i)
      i = end - 1
      continue
    }
    if (ch === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          break
        }
        j++
      }
      const end = Math.min(j + 1, sql.length)
      out += ' '.repeat(end - i)
      i = end - 1
      continue
    }
    out += ch
  }
  return out
}

/** Strip one layer of identifier quoting: "x", `x`, [x], 'x'. */
const unquote = (ident) =>
  ident.replace(/^["'`[]/, '').replace(/["'`\]]$/, '')

/**
 * The bare table name of a possibly schema-qualified, possibly quoted table
 * reference: `main.blocks`, `"main"."blocks"`, `[main].[blocks]` → `blocks`.
 * SQLite accepts a schema prefix on a DML target, and `UPDATE main.blocks`
 * writes the very same synced table. A dot INSIDE a quoted identifier doesn't
 * split, so a (pathological) table literally named `"a.b"` resolves to `a.b`.
 *
 * Deliberately over-approximates: a write to `temp.blocks` — a different table
 * in the temp schema — also reads as `blocks`. No such table exists here.
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
  // `main . blocks` — trim the whitespace SQLite allows around the dot.
  return unquote(parts[parts.length - 1].trim()).toLowerCase()
}

/** One name part: a quoted identifier (which may contain anything, including
 *  dots and spaces) or a bare run of non-delimiter characters. */
const NAME_PART = String.raw`(?:"[^"]*"|` + '`[^`]*`' + String.raw`|\[[^\]]*\]|[^\s(;.,]+)`

/** A possibly schema-qualified table reference, allowing whitespace around the
 *  dots — SQLite accepts `UPDATE main . blocks`, and a capture that stopped at
 *  the first whitespace saw only `main` and read it as an unsynced table
 *  (PR #386 review). */
const QUALIFIED_NAME = `(${NAME_PART}(?:\\s*\\.\\s*${NAME_PART})*)`

/** DML shapes, matched ANYWHERE in the sanitized text (see the module doc).
 *  `\b` on the leading verb keeps `reinsert into x` / a column named
 *  `last_update` from matching. */
const DML_PATTERNS = [
  new RegExp(String.raw`\b(?:insert(?:\s+or\s+\w+)?|replace)\s+into\s+` + QUALIFIED_NAME, 'gi'),
  new RegExp(String.raw`\bupdate\s+(?:or\s+\w+\s+)?` + QUALIFIED_NAME, 'gi'),
  new RegExp(String.raw`\bdelete\s+from\s+` + QUALIFIED_NAME, 'gi'),
]

/**
 * Every table this SQL writes to, lowercased and unqualified, in the order
 * found. Scans the whole text — nested, prefixed, and multi-statement writes
 * all surface, because position is not part of the question (module doc).
 */
const writeTargets = (sql) => {
  const text = blankCommentsAndStrings(sql)
  const targets = []
  for (const pattern of DML_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      targets.push(unqualifiedTableName(match[1]))
    }
  }
  return targets
}

/**
 * The first SYNCED table this SQL writes to, or null. This is what a guard
 * should ask — it owns the `SYNCED_TABLES` membership test so the three call
 * sites (runtime guard, agent bridge, lint rule) can't drift on what counts
 * as synced.
 */
const syncedWriteTarget = (sql) =>
  writeTargets(sql).find(target => SYNCED_TABLES.has(target)) ?? null


/** The static text a literal AST node contributes, for target matching only.
 *  A template literal's interpolated expressions are dropped (not
 *  substituted) — see the module doc on why that's the right call. */
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
      const table = syncedWriteTarget(text)
      if (table !== null) {
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
