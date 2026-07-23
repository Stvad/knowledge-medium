/**
 * The synced-table SQL recognizer — the single source of truth for "does this
 * SQL text write `blocks` / `workspaces` / `workspace_members` anywhere?".
 *
 * Two very different callers share this exact file:
 *   - `src/data/syncedTableWriteGuard.ts` imports it (via the co-located
 *     `syncedTableSqlRecognizer.d.ts`) for the RUNTIME guard that wraps a
 *     backfill `execute` and for the agent bridge's raw `sql` verb.
 *   - `eslint-rules/no-raw-synced-table-writes.js` imports it directly for
 *     the STATIC half of the same bug class (GitHub issue #404 item 1):
 *     flagging a raw write to a synced table at lint time.
 *
 * It is plain JS, not TypeScript, specifically so the ESLint rule — which
 * ESLint loads untranspiled — can `import` it with no build step. TypeScript
 * consumes it the same way (no `allowJs` needed): the sibling `.d.ts` supplies
 * the types, same pattern as shipping declarations for any untyped JS
 * dependency. Until 2026-07-20 this logic was hand-mirrored in both files —
 * see `src/test/syncedTableSqlParserParity.test.ts` (now
 * `syncedTableSqlRecognizer.test.ts`) for the corpus that used to keep the two
 * copies honest; with one copy, that test now pins the shared parser's
 * behavior directly.
 *
 * ── What this recognizer is, and what it deliberately is not ──
 *
 * It answers ONE question: *does this SQL text write a synced table anywhere?*
 * Not "what does statement N write" — that framing is what leaked. Successive
 * review rounds each found a different way for a real write to hide from a
 * leading-verb check: a `WITH …` CTE prefix, a schema qualifier
 * (`main.blocks`), a second statement after a harmless first, a comment
 * between keywords (`UPDATE /*x*\/ blocks`), and DML nested inside a
 * `CREATE TRIGGER … BEGIN … END` body that fires later, outside any tx.
 *
 * Every one of those is a position, and a positional recognizer has to
 * enumerate positions correctly to be sound. So it doesn't track position at
 * all: comments and string literals are blanked (they can hide or fake a
 * match), and the whole remaining text is scanned for a DML verb followed by a
 * table name. Nesting, prefixes, and statement boundaries stop mattering.
 *
 * What remains is TOKENIZATION — how a name is spelled (quoting, schema
 * qualifiers, whitespace around the dots). That axis is handled explicitly
 * below and is where the later reports landed. Be honest about the standing
 * limit: this is a conservative recognizer, not a SQL parser, so an
 * exotic-enough spelling can still slip past it. It is one of three layers
 * (the runtime guard, the ESLint rule, code review), each cheap and none sound
 * alone; if a spelling slips, widen the tokenizer or move enforcement, but
 * don't mistake it for a complete parser.
 *
 * The tradeoff is deliberate: it OVER-approximates. `INSERT INTO block_aliases
 * … SELECT … FROM blocks` stays clean (the verb-adjacent name is the target),
 * as does `CREATE TRIGGER … AFTER UPDATE ON blocks` (the token after UPDATE is
 * `ON`) — but a synced name sitting in DML position anywhere is a hit, even in
 * a trigger body that only fires later, which is exactly right: that trigger
 * WILL write outside a tx. For a guard with an explicit override, false
 * positives cost a conversation and false negatives cost silent data loss.
 */

/** App-visible / synced tables whose changes must propagate through the upload
 *  path. These are exact names: `blocks_fts`, `blocks_synced`, `block_aliases`,
 *  etc. are deliberately NOT here — they are local.
 *
 *  Exported so other callers that need the same "is this a synced table"
 *  check (e.g. the agent bridge's raw `sql` verb) share this single list
 *  instead of re-deriving it. */
export const SYNCED_TABLES = new Set(['blocks', 'workspaces', 'workspace_members'])

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
const blankCommentsAndStrings = (sql, keepStrings = false) => {
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
    if (ch === "'" && !keepStrings) {
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

/** As {@link NAME_PART}, but also accepting a SINGLE-quoted name. SQLite
 *  really does take `UPDATE 'blocks' SET …` as a write to the table (verified
 *  against the engine, not inferred) — a misfeature, but a live one. This
 *  spelling is scanned separately, over text whose string literals are still
 *  intact, because the main scan blanks them: a name can hide in a literal,
 *  and prose can fake a write from inside one. */
const NAME_PART_Q = String.raw`(?:'[^']*'|` + NAME_PART.slice(3)

/** A possibly schema-qualified table reference, allowing whitespace around the
 *  dots — SQLite accepts `UPDATE main . blocks`, and a capture that stopped at
 *  the first whitespace saw only `main` and read it as an unsynced table
 *  (PR #386 review). */
const QUALIFIED_NAME = `(${NAME_PART}(?:\\s*\\.\\s*${NAME_PART})*)`
const QUALIFIED_NAME_Q = `(${NAME_PART_Q}(?:\\s*\\.\\s*${NAME_PART_Q})*)`

/** DML shapes, matched ANYWHERE in the sanitized text (see the module doc).
 *  `\b` on the leading verb keeps `reinsert into x` / a column named
 *  `last_update` from matching. */
const DML_PATTERNS = [
  new RegExp(String.raw`\b(?:insert(?:\s+or\s+\w+)?|replace)\s+into\s+` + QUALIFIED_NAME, 'gi'),
  new RegExp(String.raw`\bupdate\s+(?:or\s+\w+\s+)?` + QUALIFIED_NAME, 'gi'),
  new RegExp(String.raw`\bdelete\s+from\s+` + QUALIFIED_NAME, 'gi'),
]

/** The same shapes, but for a target spelled with SINGLE quotes. Run over
 *  strings-intact text, so the match is only trusted when the NAME ITSELF is
 *  quoted — that is what keeps prose out: in `VALUES ('update blocks now')`
 *  the token after `update` is bare `blocks`, so nothing matches here, while
 *  `UPDATE 'blocks'` does. */
const QUOTED_NAME_DML_PATTERNS = [
  new RegExp(String.raw`\b(?:insert(?:\s+or\s+\w+)?|replace)\s+into\s+` + QUALIFIED_NAME_Q, 'gi'),
  new RegExp(String.raw`\bupdate\s+(?:or\s+\w+\s+)?` + QUALIFIED_NAME_Q, 'gi'),
  new RegExp(String.raw`\bdelete\s+from\s+` + QUALIFIED_NAME_Q, 'gi'),
]

/**
 * DESTRUCTIVE DDL shapes (PR #386 review). `DROP TABLE blocks` desyncs the
 * local store more completely than any UPDATE could, and a DML-only scan
 * waved it through — so the same guard has to see it.
 *
 * The line is drawn at DESTRUCTIVE, not at DDL in general: additive schema
 * evolution against a synced table is legitimate and must not be refused.
 * The bootstrap adds local columns to both synced tables via `ALTER TABLE …
 * ADD COLUMN` (`blockSchema.ts`, `workspaceSchema.ts`) and hangs every
 * row/upload trigger off `blocks`. So: DROP TABLE, and the ALTER forms that
 * REMOVE or RENAME existing structure; never ADD COLUMN, never CREATE/DROP
 * TRIGGER or INDEX (a trigger's name may start with the table's, but
 * `unqualifiedTableName` compares the whole name, so `blocks_upload_insert`
 * is not `blocks`).
 *
 * Correcting the first version of this comment (PR #386 areview): it claimed
 * those bootstrap statements run THROUGH this guard, so a blanket DDL rule
 * would brick startup. They do not — `repoProvider.ts` calls
 * `ensureBlockLocalColumns(powerSyncDb)` on the UNGUARDED handle, and only
 * the one-shot side-index backfills use the guarded `backfillDb`. The
 * narrowing above is still right, but on principle rather than on that
 * (false) blast radius. The realistic destructive caller is the agent
 * bridge's raw `sql` verb, which is exactly where a `DROP TABLE blocks`
 * would come from.
 *
 * The verb sits AFTER the table name in the ALTER forms, which is why these
 * can't just be folded into {@link DML_PATTERNS}.
 */
const DDL_PATTERNS = [
  new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?` + QUALIFIED_NAME, 'gi'),
  new RegExp(String.raw`\balter\s+table\s+` + QUALIFIED_NAME + String.raw`\s+(?:rename|drop)\b`, 'gi'),
]

/** {@link DDL_PATTERNS} for a single-quoted target, same rationale as
 *  {@link QUOTED_NAME_DML_PATTERNS}. */
const QUOTED_NAME_DDL_PATTERNS = [
  new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?` + QUALIFIED_NAME_Q, 'gi'),
  new RegExp(String.raw`\balter\s+table\s+` + QUALIFIED_NAME_Q + String.raw`\s+(?:rename|drop)\b`, 'gi'),
]

/**
 * Every table this SQL writes to, lowercased and unqualified, in the order
 * found. Scans the whole text — nested, prefixed, and multi-statement writes
 * all surface, because position is not part of the question (module doc).
 */
export const writeTargets = (sql) => {
  const targets = []
  const collect = (text, patterns, quotedOnly) => {
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        // The strings-intact pass only trusts a name that is itself quoted;
        // an unquoted match there could be text inside a literal.
        if (quotedOnly && !match[1].includes("'")) continue
        targets.push(unqualifiedTableName(match[1]))
      }
    }
  }
  // Two blanked variants, each scanned by both its DML and DDL pattern sets —
  // `blankCommentsAndStrings` is a full character walk, so hoist rather than
  // re-derive the identical text per pattern set.
  const blanked = blankCommentsAndStrings(sql)
  const stringsIntact = blankCommentsAndStrings(sql, true)
  collect(blanked, DML_PATTERNS, false)
  collect(blanked, DDL_PATTERNS, false)
  collect(stringsIntact, QUOTED_NAME_DML_PATTERNS, true)
  collect(stringsIntact, QUOTED_NAME_DDL_PATTERNS, true)
  return targets
}

/**
 * The first SYNCED table this SQL writes to, or null. This is what a guard
 * should ask — it owns the `SYNCED_TABLES` membership test so the three call
 * sites (runtime guard, agent bridge, lint rule) can't drift on what counts
 * as synced.
 */
export const syncedWriteTarget = (sql) =>
  writeTargets(sql).find(target => SYNCED_TABLES.has(target)) ?? null
