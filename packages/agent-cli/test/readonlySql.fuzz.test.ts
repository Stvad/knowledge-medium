// @vitest-environment node
/**
 * Fuzz suite for `isReadOnlySql` (packages/agent-cli/src/protocol.ts:362-371)
 * — the textual read-only guard shared by every surface that runs SQL on
 * someone else's authority (km MCP graph tools, agent-dispatch watcher
 * configs, watch-events registrations, the bridge's read-only token scope).
 * See docs/fuzzing.md for tier mechanics and `src/test/fuzz.ts` for
 * `fuzzParams`/`fuzzTestTimeout`.
 *
 * ──── Threat model, grounded at the call site ────
 *
 * `isReadOnlySql` denies a string unless it is: a single statement (no
 * unstripped `;`, protocol.ts:363-364), makes no `powersync_*` call
 * (protocol.ts:351,365 — these UDFs run on the SAME wa-sqlite connection
 * and can wipe/corrupt local state regardless of a SELECT prologue), and
 * either has a SELECT/PRAGMA-info/EXPLAIN prologue (protocol.ts:366) or is
 * a `WITH` whose body contains no mutating keyword (protocol.ts:367-369 —
 * SQLite accepts `WITH … UPDATE/INSERT/DELETE` as the *main* statement, so
 * `WITH` alone proves nothing).
 *
 * All properties below build adversarial SQL by STRUCTURED COMPOSITION —
 * known-mutating or known-read-only fragments assembled with random case,
 * random comment/whitespace placement (incl. Unicode whitespace), and
 * random CTE nesting — never by reading protocol.ts's own regexes. Ground
 * truth is the FRAGMENT the case was built from (independent of the guard),
 * not a re-implementation of its pattern-matching, which is what makes this
 * a real differential rather than a restatement.
 *
 * Two properties are semantically inert by construction and intentionally
 * NOT generated as "should be true" cases, to avoid encoding a wrong oracle:
 *
 *   - Splitting a KEYWORD or the powersync_* IDENTIFIER itself with a
 *     comment (`SEL/**‍/ECT`, `powersync/**‍/_crud`) is not a real evasion:
 *     SQL comments are lexed as whitespace BETWEEN tokens, never inside
 *     one, so a split token is not the keyword/identifier at all — the
 *     string fails to parse (or silently means something else) and never
 *     reaches the powersync_* UDF or performs the mutation either way.
 *     protocol.ts:344-349 makes exactly this argument for why the bare-
 *     token match (not `name\s*\(`) is "comment-proof". Generated instead:
 *     comments/whitespace BETWEEN the function name and its `(` — a real,
 *     syntactically valid call the code explicitly targets.
 *   - Homoglyph identifiers (Cyrillic о for Latin o) don't resolve to the
 *     registered UDF either — SQLite matches function names byte-exact —
 *     so under-matching them isn't exploitable. Not generated.
 *
 * ──── Findings (over-conservative, NOT red — see docs/fuzzing.md "over-
 * blocking is acceptable, under-blocking is a real bug") ────
 *
 *   1. protocol.ts:364 checks `body.includes(';')` on the whole string, so
 *      a semicolon inside a STRING LITERAL rejects an otherwise-valid
 *      single read-only statement (`SELECT ';'`). Documented below rather
 *      than asserted as a fuzz property (which would encode the wrong
 *      oracle for the direction that matters).
 *   2. protocol.ts:366's prologue alternation hardcodes a single literal
 *      ASCII space inside `"pragma table_info"` (not `\s+`), so
 *      `PRAGMA  table_info(...)` (extra space) or `PRAGMA/**‍/table_info(...)`
 *      (comment-as-whitespace, valid SQL) fails the prologue match, falls
 *      through the `with` branch too, and is rejected — a legitimate
 *      read-only PRAGMA wrongly denied.
 *
 * No properties below assert either finding should pass; they're recorded
 * as fixed-example regressions of CURRENT (accepted) behavior so a future
 * change to the prologue/semicolon check is a deliberate, reviewed diff,
 * not a silent behavior flip.
 */
import {describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {isReadOnlySql} from '../src/protocol'

// ──── shared generator building blocks ────

/** Case-scrambles a fixed word letter-by-letter — independent of the `/i`
 *  flag protocol.ts's regexes rely on, so this actually exercises it. */
const caseVariantArb = (word: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), {minLength: word.length, maxLength: word.length})
    .map(bits => word.split('').map((ch, i) => (bits[i] ? ch.toUpperCase() : ch.toLowerCase())).join(''))

/** Token separators: plain ASCII whitespace plus a spread of Unicode
 *  space/line-separator characters that `String.prototype.trim()` and
 *  JS's `\s` both treat as whitespace, but that are members of no
 *  reasonable "keyword" — probes dimension (d) (unicode whitespace around
 *  keywords) inside every other property instead of as a separate one,
 *  since it's a cross-cutting concern (every token boundary below already
 *  draws its separator from this pool). */
const WS_POOL = [
  ' ', ' ', ' ', // bias toward plain ASCII space so generated SQL mostly "looks normal"
  '\t', '\n',
  '\u00A0', // NBSP
  '\u2003', // EM SPACE
  '\u2028', // LINE SEPARATOR
  '\u3000', // IDEOGRAPHIC SPACE
  '\uFEFF', // ZERO WIDTH NO-BREAK SPACE / BOM — part of ECMAScript's WhiteSpace grammar
] as const
const wsRunArb: fc.Arbitrary<string> =
  fc.array(fc.constantFrom(...WS_POOL), {minLength: 1, maxLength: 3}).map(a => a.join(''))

/** A comment, valid SQL whitespace-equivalent anywhere a space is legal
 *  (the mechanism protocol.ts:344-349's docstring itself relies on). */
const commentArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant('/**/'),
  fc.constant('/* x */'),
  fc.constant('--x\n'),
)

// ──── (a) powersync_* UDF calls: case variance + comment/whitespace
//       wedged BETWEEN the function name and its `(` — never inside the
//       name itself (see docblock: that's not a real call) ────

const POWERSYNC_KNOWN_SUFFIXES = ['crud', 'control', 'clear', 'replace_schema'] as const

/** Suffix pool: known writable UDFs plus generic identifier-shaped
 *  strings, so the property doesn't just re-confirm a hardcoded list —
 *  SIDE_EFFECTING_FN (protocol.ts:351) matches the bare `powersync_`
 *  PREFIX, so it must deny every suffix, not just the four named ones. */
const powersyncSuffixArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...POWERSYNC_KNOWN_SUFFIXES),
  fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,9}$/),
)

const powersyncCallArb: fc.Arbitrary<string> = fc.record({
  namePrefix: caseVariantArb('powersync_'),
  suffix: powersyncSuffixArb,
  nameParenGap: fc.oneof(fc.constant(''), wsRunArb, commentArb),
  args: fc.constantFrom('', '1', "'x'"),
}).map(({namePrefix, suffix, nameParenGap, args}) => `${namePrefix}${suffix}${nameParenGap}(${args})`)

const powersyncStatementArb: fc.Arbitrary<string> = fc.record({
  call: powersyncCallArb,
  style: fc.constantFrom('bare-select', 'select-where', 'with-select', 'explain-select'),
  ws: wsRunArb,
}).map(({call, style, ws}) => {
  switch (style) {
    case 'bare-select': return `SELECT${ws}${call}`
    case 'select-where': return `SELECT${ws}*${ws}FROM${ws}blocks${ws}WHERE${ws}${call}${ws}=${ws}1`
    case 'with-select': return `WITH${ws}x${ws}AS${ws}(SELECT${ws}1)${ws}SELECT${ws}${call}`
    case 'explain-select': return `EXPLAIN${ws}SELECT${ws}${call}`
    default: throw new Error(`unreachable: ${style}`)
  }
})

// ──── (c) multi-statement strings, incl. the false-positive probe
//       (semicolon inside a quoted string, the OTHER direction) ────

const READ_ONLY_FRAGMENTS = ['SELECT 1', 'SELECT * FROM blocks', 'PRAGMA table_info(blocks)'] as const

// ──── (c) WITH/CTE bodies hiding a mutating verb, at random CTE depth ────

const MUTATING_FRAGMENTS: Record<string, string> = {
  insert: 'INSERT INTO t (a) VALUES (1)',
  update: 'UPDATE t SET a = 1',
  delete: 'DELETE FROM t',
  replace: 'REPLACE INTO t (a) VALUES (1)',
  drop: 'DROP TABLE t',
  alter: 'ALTER TABLE t ADD COLUMN a',
  create: 'CREATE TABLE t (a)',
  vacuum: 'VACUUM',
  attach: "ATTACH DATABASE 'x' AS y",
  detach: 'DETACH DATABASE y',
  reindex: 'REINDEX t',
}

/** Case-scrambles only the leading verb of a mutating fragment (the part
 *  the blacklist regex, protocol.ts:368, keys on); keeps the rest as-is. */
const mutatingFragmentArb: fc.Arbitrary<string> = fc
  .constantFrom(...Object.values(MUTATING_FRAGMENTS))
  .chain(fragment => {
    const spaceIdx = fragment.indexOf(' ')
    const verb = spaceIdx === -1 ? fragment : fragment.slice(0, spaceIdx)
    const rest = spaceIdx === -1 ? '' : fragment.slice(spaceIdx)
    return caseVariantArb(verb).map(v => `${v}${rest}`)
  })

/** `n` (1-3) chained CTEs, each referencing the previous — "random depth"
 *  nesting ahead of the mutating main statement, the one syntactic
 *  position (besides a UDF call) a mutating verb can legally occupy in a
 *  `WITH`-headed statement (INSERT/UPDATE/DELETE/etc. are statements, not
 *  expressions, so they can't hide inside a CTE's own SELECT body). */
const cteListArb: fc.Arbitrary<string> = fc.integer({min: 1, max: 3}).chain(n =>
  fc.array(wsRunArb, {minLength: n + 1, maxLength: n + 1}).map(wsList => {
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      const body = i === 0 ? 'SELECT 1' : `SELECT * FROM c${i - 1}`
      parts.push(`c${i}${wsList[i]}AS${wsList[i]}(${body})`)
    }
    return parts.join(`,${wsList[n]}`)
  }),
)

const withMutatingStatementArb: fc.Arbitrary<string> = fc.record({
  withCase: caseVariantArb('with'),
  cteList: cteListArb,
  ws: wsRunArb,
  mutating: mutatingFragmentArb,
}).map(({withCase, cteList, ws, mutating}) => `${withCase}${ws}${cteList}${ws}${mutating}`)

const multiStatementArb: fc.Arbitrary<string> = fc.record({
  first: fc.oneof(fc.constantFrom(...READ_ONLY_FRAGMENTS, ...Object.values(MUTATING_FRAGMENTS)), powersyncStatementArb),
  second: fc.oneof(fc.constantFrom(...READ_ONLY_FRAGMENTS, ...Object.values(MUTATING_FRAGMENTS)), powersyncStatementArb),
  ws1: wsRunArb,
  ws2: wsRunArb,
  trailingSemi: fc.boolean(),
}).map(({first, second, ws1, ws2, trailingSemi}) => `${first}${ws1};${ws2}${second}${trailingSemi ? ';' : ''}`)

// ──── completeness spot-check: genuinely read-only SELECTs classify true
//      (report, don't redden, if this is ever over-conservative) ────

const SAFE_TABLES = ['blocks', 'block_references', 'workspace_config'] as const
const SAFE_COLUMNS = ['id', 'content', 'workspace_id', 'order_key'] as const

const readOnlySelectArb: fc.Arbitrary<string> = fc.record({
  selectCase: caseVariantArb('select'),
  col: fc.constantFrom('*', ...SAFE_COLUMNS),
  fromCase: caseVariantArb('from'),
  table: fc.constantFrom(...SAFE_TABLES),
  ws: wsRunArb,
}).map(({selectCase, col, fromCase, table, ws}) => `${selectCase}${ws}${col}${ws}${fromCase}${ws}${table}`)

const readOnlyWithArb: fc.Arbitrary<string> = fc.record({
  withCase: caseVariantArb('with'),
  ws: wsRunArb,
  inner: readOnlySelectArb,
  outerSelectCase: caseVariantArb('select'),
  outerCol: fc.constantFrom('*', ...SAFE_COLUMNS),
  outerFromCase: caseVariantArb('from'),
}).map(({withCase, ws, inner, outerSelectCase, outerCol, outerFromCase}) =>
  `${withCase}${ws}x${ws}AS${ws}(${inner})${ws}${outerSelectCase}${ws}${outerCol}${ws}${outerFromCase}${ws}x`)

const genuinelyReadOnlyArb: fc.Arbitrary<string> = fc.oneof(
  readOnlySelectArb,
  readOnlyWithArb,
  fc.constant('PRAGMA table_info(blocks)'),
  fc.constant('EXPLAIN SELECT 1'),
  fc.constant('EXPLAIN QUERY PLAN SELECT 1'),
)

describe('isReadOnlySql — soundness (never true for mutating SQL)', () => {
  it('denies any statement calling a powersync_* UDF — any suffix, case, and name/paren gap (protocol.ts:339-351,365)', () => {
    fc.assert(
      fc.property(powersyncStatementArb, sql => {
        expect(isReadOnlySql(sql)).toBe(false)
      }),
      fuzzParams(250),
    )
  }, fuzzTestTimeout())

  it('denies any WITH-headed statement whose main verb (after 1-3 chained CTEs) mutates, any case (protocol.ts:358-359,367-369)', () => {
    fc.assert(
      fc.property(withMutatingStatementArb, sql => {
        expect(isReadOnlySql(sql)).toBe(false)
      }),
      fuzzParams(250),
    )
  }, fuzzTestTimeout())

  it('denies any two statements joined by `;`, regardless of statement content (protocol.ts:363-364)', () => {
    fc.assert(
      fc.property(multiStatementArb, sql => {
        expect(isReadOnlySql(sql)).toBe(false)
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})

describe('isReadOnlySql — completeness spot-check (report, do not redden, if over-conservative)', () => {
  it('classifies genuinely read-only SELECTs, incl. WITH x AS (SELECT...) SELECT, as read-only (protocol.ts:362-371)', () => {
    fc.assert(
      fc.property(genuinelyReadOnlyArb, sql => {
        expect(isReadOnlySql(sql)).toBe(true)
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})

describe('isReadOnlySql — documented over-blocking (fixed examples, not fuzz properties)', () => {
  it('rejects a read-only SELECT whose only `;` is inside a string literal (protocol.ts:364 scans the whole body)', () => {
    // `SELECT ';'` is a valid, harmless single statement; body.includes(';')
    // can't distinguish a literal semicolon from a separator. Over-blocking
    // (acceptable per docs/fuzzing.md) — pinned so a future change to this
    // check is a deliberate diff.
    expect(isReadOnlySql("SELECT ';'")).toBe(false)
  })

  it('rejects PRAGMA table_info with non-single-space between the two words (protocol.ts:366 hardcodes one literal space)', () => {
    // The prologue alternation embeds a literal ASCII space inside the
    // string `"pragma table_info"`, not `\s+` — valid SQL with extra
    // whitespace, or a comment (whitespace-equivalent), between the two
    // words misses the prologue match and falls through to `return false`.
    expect(isReadOnlySql('PRAGMA  table_info(blocks)')).toBe(false)
    expect(isReadOnlySql('PRAGMA/**/table_info(blocks)')).toBe(false)
    // The single-space form is the one actually accepted.
    expect(isReadOnlySql('PRAGMA table_info(blocks)')).toBe(true)
  })
})
