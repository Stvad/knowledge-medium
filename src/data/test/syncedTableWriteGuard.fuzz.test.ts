// @vitest-environment node
/**
 * Fuzz suite for `src/data/syncedTableSqlRecognizer.js`'s `writeTargets` /
 * `syncedWriteTarget` (re-exported from `src/data/syncedTableWriteGuard.ts`,
 * which wraps them into `guardSyncedTableWrites`). See `src/test/fuzz.ts` for
 * the smoke/deep tier mechanics and `docs/fuzzing.md` for conventions.
 *
 * ──── Why this guard exists (grounded in syncedTableWriteGuard.ts:1-24) ────
 *
 * Uploads are driven by `blocks_upload_*` triggers gated on
 * `tx_context.source IS NOT NULL`, set only by `repo.tx(...)`. A raw
 * `db.execute('UPDATE blocks …')` from a LocalSchema statement/backfill
 * leaves `source = NULL`, so the row silently never syncs — the failure that
 * stranded the `daily-note:date` backfill for ~19 days (May 2026 incident,
 * removed in `8c50f167`). `guardSyncedTableWrites` (syncedTableWriteGuard.ts:40-62)
 * wraps a backfill `execute` and rejects before the write runs whenever
 * `syncedWriteTarget(sql)` is non-null.
 *
 * ──── What the recognizer actually does (grounded in
 * syncedTableSqlRecognizer.js) ────
 *
 * It is NOT a positional parser: comments and single-quoted string literals
 * are blanked to same-length whitespace (`blankCommentsAndStrings`,
 * :79-114) and the DML/DDL patterns (:179-183, :224-227) are matched
 * ANYWHERE in the remaining text, `g`-flagged — a CTE prefix, a second
 * statement, or a trigger body all surface identically to a leading verb
 * (module doc :23-55). `unqualifiedTableName` (:130-155) strips one layer of
 * quoting (`"x"`, `` `x` ``, `[x]`, `'x'`) and a schema qualifier
 * (`main.blocks` → `blocks`), tolerating whitespace around the dot.
 * Single-quoted table names (`UPDATE 'blocks' SET …` — a real SQLite
 * misfeature, verified against the engine per the module doc :161-166) are
 * matched by a SEPARATE pass over string-literals-intact text
 * (`QUOTED_NAME_DML_PATTERNS`/`QUOTED_NAME_DDL_PATTERNS`, :190-194,
 * :231-234), gated so a match only counts when the captured name is ITSELF
 * quoted — otherwise prose like `VALUES ('update blocks now')` would fake a
 * write (:247-249).
 *
 * `writeTargets` (:241-264) returns every table written, in text order;
 * `syncedWriteTarget` (:272-273) is the first one in `SYNCED_TABLES`
 * (`blocks` / `workspaces` / `workspace_members`, :64) or `null`.
 *
 * ──── Generator design ────
 *
 * Ground truth is BY CONSTRUCTION, never by re-deriving the recognizer's own
 * patterns: every "true write" case is assembled by substituting a
 * differently-spelled reference to a KNOWN table name into a KNOWN-mutating
 * SQL template (INSERT / INSERT OR REPLACE / INSERT OR IGNORE / UPDATE /
 * UPDATE OR IGNORE / DELETE / REPLACE, plus the destructive DDL forms DROP
 * TABLE / ALTER … RENAME / ALTER … DROP COLUMN the module doc :196-227 says
 * the same guard must catch), with random whitespace/comment separators
 * spliced at every position the grammar allows one. Every "decoy" case is
 * assembled from a template that is independently known to not write the
 * synced table it mentions (a read, an unsynced-table write that merely
 * selects FROM the synced table, additive DDL, a trigger HEADER naming the
 * table after the event, or prose inside a string literal) — never by
 * checking what the recognizer says about it.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { SYNCED_TABLES, syncedWriteTarget, writeTargets } from '@/data/syncedTableWriteGuard'

// ──── shared generator building blocks ────

/** Whitespace the recognizer's `\s+`/`\s*` actually match (JS regex `\s`,
 *  which SQLite's own lexer treats as whitespace too for the ASCII/NBSP
 *  members here) plus newlines, biased toward a single plain space so most
 *  generated SQL "looks normal". */
const WS_POOL = [' ', ' ', ' ', '\t', '\n', '\r', ' ', ' ', '　'] as const
const wsRunArb: fc.Arbitrary<string> =
  fc.array(fc.constantFrom(...WS_POOL), { minLength: 1, maxLength: 3 }).map(a => a.join(''))

/** A comment — valid SQL whitespace-equivalent anywhere a space is legal;
 *  `blankCommentsAndStrings` (:79-96) replaces it with same-length spaces
 *  before the DML/DDL patterns ever run, so it satisfies a mandatory `\s+`
 *  exactly like a real space run. */
const commentArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant('/**/'),
  fc.constant('/* note */'),
  fc.constant('--note\n'),
)

/** A mandatory separator (the grammar requires `\s+` at this join point):
 *  plain whitespace, a comment, or both back to back. */
const sep1Arb: fc.Arbitrary<string> = fc.oneof(
  wsRunArb,
  commentArb,
  fc.tuple(commentArb, wsRunArb).map(([c, w]) => c + w),
)

/** An optional separator (the grammar allows `\s*` here, e.g. around the
 *  schema-qualifier dot). */
const sep0Arb: fc.Arbitrary<string> = fc.oneof(fc.constant(''), sep1Arb)

const SYNCED = [...SYNCED_TABLES] as const

/** Every quoting style `unqualifiedTableName` (:117-118, :130-155) strips
 *  one layer of, EXCLUDING the single-quote spelling (that one only matches
 *  through the separate strings-intact pass and is generated on its own
 *  below, gated by the recognizer's "only when the captured name is itself
 *  quoted" rule). */
const doubleQuote = (name: string) => `"${name}"`
const backtick = (name: string) => '`' + name + '`'
const bracket = (name: string) => `[${name}]`
const QUOTE_STYLES: Array<(name: string) => string> = [
  name => name,
  doubleQuote,
  backtick,
  bracket,
]

/** A reference to `table`, optionally schema-qualified with `main`, using
 *  double/backtick/bracket/bare quoting independently on each part —
 *  `unqualifiedTableName` always resolves to `table` regardless (module doc
 *  :120-129: "a possibly schema-qualified, possibly quoted table
 *  reference"). Does NOT cover the single-quoted spelling — see
 *  {@link singleQuotedTableRefArb}. */
const quotedRefArb = (table: string): fc.Arbitrary<string> =>
  fc.record({
    schema: fc.option(fc.constantFrom(...QUOTE_STYLES), { nil: undefined }),
    nameStyle: fc.constantFrom(...QUOTE_STYLES),
    dotSep: sep0Arb,
  }).map(({ schema, nameStyle, dotSep }) => {
    const name = nameStyle(table)
    return schema === undefined ? name : `${schema('main')}${dotSep}.${dotSep}${name}`
  })

/** The single-quoted spelling (`'blocks'`, optionally `main.'blocks'`) —
 *  matched by the SEPARATE strings-intact pass (:161-167, :190-194). Kept
 *  apart from {@link quotedRefArb} because it exercises a genuinely
 *  different code path, not just another quoting branch. */
const singleQuotedTableRefArb = (table: string): fc.Arbitrary<string> =>
  fc.record({
    withSchema: fc.boolean(),
    dotSep: sep0Arb,
  }).map(({ withSchema, dotSep }) =>
    withSchema ? `main${dotSep}.${dotSep}'${table}'` : `'${table}'`,
  )

const tableRefArb = (table: string): fc.Arbitrary<string> =>
  fc.oneof(quotedRefArb(table), singleQuotedTableRefArb(table))

// ──── true-write templates: DML (INSERT / INSERT OR REPLACE / INSERT OR
//      IGNORE / UPDATE / UPDATE OR IGNORE / DELETE / REPLACE) ────

type RefBuilder = (ref: string, sep: () => string) => string

const DML_TEMPLATES: RefBuilder[] = [
  (ref, sep) => `INSERT${sep()}INTO${sep()}${ref}${sep0()}(id)${sep0()}VALUES${sep0()}(?)`,
  (ref, sep) => `INSERT${sep()}OR${sep()}REPLACE${sep()}INTO${sep()}${ref}${sep0()}(id)${sep0()}VALUES${sep0()}(?)`,
  (ref, sep) => `INSERT${sep()}OR${sep()}IGNORE${sep()}INTO${sep()}${ref}${sep0()}(id)${sep0()}VALUES${sep0()}(?)`,
  (ref, sep) => `UPDATE${sep()}${ref}${sep()}SET${sep()}x${sep0()}=${sep0()}1`,
  (ref, sep) => `UPDATE${sep()}OR${sep()}IGNORE${sep()}${ref}${sep()}SET${sep()}x${sep0()}=${sep0()}1`,
  (ref, sep) => `DELETE${sep()}FROM${sep()}${ref}${sep()}WHERE${sep()}id${sep0()}=${sep0()}1`,
  (ref, sep) => `REPLACE${sep()}INTO${sep()}${ref}${sep0()}(id)${sep0()}VALUES${sep0()}(?)`,
]

// ──── true-write templates: destructive DDL (DROP TABLE / ALTER … RENAME /
//      ALTER … DROP COLUMN — module doc :196-227) ────

const DDL_TEMPLATES: RefBuilder[] = [
  (ref, sep) => `DROP${sep()}TABLE${sep()}${ref}`,
  (ref, sep) => `DROP${sep()}TABLE${sep()}IF${sep()}EXISTS${sep()}${ref}`,
  (ref, sep) => `ALTER${sep()}TABLE${sep()}${ref}${sep()}RENAME${sep()}TO${sep()}old_x`,
  (ref, sep) => `ALTER${sep()}TABLE${sep()}${ref}${sep()}RENAME${sep()}COLUMN${sep()}content${sep()}TO${sep()}body`,
  (ref, sep) => `ALTER${sep()}TABLE${sep()}${ref}${sep()}DROP${sep()}COLUMN${sep()}content`,
]

// helper used inline by the templates above — a fixed, always-legal
// zero-or-more-whitespace filler for cosmetic spots the grammar doesn't
// actually require a separator at (e.g. around `(`/`)`/`=`), so the
// generated SQL isn't needlessly cramped without adding another axis of
// randomness that matters to the property.
const sep0 = () => ' '

const writeTemplateArb: fc.Arbitrary<RefBuilder> = fc.constantFrom(...DML_TEMPLATES, ...DDL_TEMPLATES)

/** One true-write case: `{sql, expected}` where `expected` is the synced
 *  table name the SQL is built to write, chosen independently of anything
 *  the recognizer computes. */
const trueWriteCaseArb: fc.Arbitrary<{ sql: string; expected: string }> =
  fc.record({
    table: fc.constantFrom(...SYNCED),
    template: writeTemplateArb,
    cte: fc.boolean(),
    // One separator VALUE per case, reused at every mandatory `\s+` join in
    // that statement. Still random across cases (whitespace runs, comments,
    // or both), and the recognizer's `\s+` doesn't care whether consecutive
    // joins in one statement happen to share the same literal text.
    sepText: sep1Arb,
  }).chain(({ table, template, cte, sepText }) =>
    tableRefArb(table).map(ref => {
      const sep = () => sepText
      const stmt = template(ref, sep)
      const sql = cte ? `WITH${sepText}x${sepText}AS${sepText}(SELECT${sepText}1)${sepText}${stmt}` : stmt
      return { sql, expected: table }
    }),
  )

// ──── decoy templates: mention a synced table WITHOUT writing it ────

const UNSYNCED_TABLES = ['block_aliases', 'block_types', 'client_schema_state'] as const

const decoyTemplateArb = (table: string): fc.Arbitrary<string> => fc.oneof(
  fc.constant(`SELECT * FROM ${table} WHERE deleted = 0`),
  fc.constant(`SELECT id, content FROM ${table}`),
  fc.constantFrom(...UNSYNCED_TABLES).map(other =>
    `INSERT OR IGNORE INTO ${other} (block_id) SELECT id FROM ${table}`),
  fc.constant(`CREATE INDEX i ON ${table} (x) WHERE deleted = 0`),
  fc.constant(`CREATE TRIGGER t AFTER UPDATE ON ${table} BEGIN SELECT 1; END`),
  fc.constant(`CREATE TRIGGER t AFTER INSERT ON ${table} BEGIN SELECT 1; END`),
  fc.constant(`CREATE TRIGGER t AFTER DELETE ON ${table} BEGIN SELECT 1; END`),
  fc.constant(`ALTER TABLE ${table} ADD COLUMN extra_col TEXT`),
  fc.constant(`DROP TRIGGER IF EXISTS ${table}_upload_insert`),
  fc.constantFrom(...UNSYNCED_TABLES).map(other =>
    `INSERT INTO ${other} (note) VALUES ('update ${table} now')`),
  fc.constant(`PRAGMA table_info(${table})`),
)

/** One decoy case: `{sql, expected: null}` — `sql` mentions `table` but is
 *  built from a template independently known not to write it. */
const decoyCaseArb: fc.Arbitrary<{ sql: string; expected: null }> =
  fc.constantFrom(...SYNCED).chain(table => decoyTemplateArb(table)).map(sql => ({ sql, expected: null as null }))

// ──── multi-statement composition: a true-write and a decoy joined by `;`,
//      in random order, with an optional trailing `;` — the write's target
//      must surface regardless of which statement it sits in ────

const multiStatementCaseArb: fc.Arbitrary<{ sql: string; expected: string }> =
  fc.record({
    write: trueWriteCaseArb,
    decoy: decoyCaseArb,
    writeFirst: fc.boolean(),
    ws1: wsRunArb,
    ws2: wsRunArb,
    trailingSemi: fc.boolean(),
  }).map(({ write, decoy, writeFirst, ws1, ws2, trailingSemi }) => {
    const [first, second] = writeFirst ? [write.sql, decoy.sql] : [decoy.sql, write.sql]
    const sql = `${first}${ws1};${ws2}${second}${trailingSemi ? ';' : ''}`
    return { sql, expected: write.expected }
  })

describe('syncedWriteTarget / writeTargets — soundness (every true write is caught)', () => {
  it('classifies a syntactically-varied true write as its synced target table', () => {
    fc.assert(
      fc.property(trueWriteCaseArb, ({ sql, expected }) => {
        expect(syncedWriteTarget(sql), sql).toBe(expected)
        expect(writeTargets(sql), sql).toContain(expected)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('still catches the true write when it sits behind a WITH-CTE prefix or a leading decoy statement', () => {
    fc.assert(
      fc.property(multiStatementCaseArb, ({ sql, expected }) => {
        expect(syncedWriteTarget(sql), sql).toBe(expected)
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})

describe('syncedWriteTarget — completeness (a decoy that only MENTIONS a synced table is never flagged)', () => {
  it('does not misclassify a read, an unsynced-table write, additive DDL, a trigger header, or prose-in-a-literal', () => {
    fc.assert(
      fc.property(decoyCaseArb, ({ sql, expected }) => {
        expect(syncedWriteTarget(sql), sql).toBe(expected)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
