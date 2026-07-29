// @vitest-environment node
/**
 * Fuzz suite for `renderSubtreeOutline` / `neutralizeOutlineField` /
 * `encodeOutlineId` / `decodeOutlineId`
 * (packages/agent-cli/src/subtreeOutline.ts). See
 * `packages/agent-cli/test/readonlySql.fuzz.test.ts` for the in-package
 * house style and `docs/fuzzing.md` for tier mechanics.
 *
 * Note on the agent-cli "protocol resolves to dist" test gotcha: it doesn't
 * apply here — `subtreeOutline.ts` has ZERO imports (module docblock
 * :1-12 says so explicitly, "unit-testable... importing cli.ts would run
 * the CLI entrypoint"), so there's no `protocol.ts`/dist dependency to
 * compile first. Confirmed by running the existing (non-fuzz)
 * `subtreeOutline.test.ts` straight from source with no build step.
 *
 * ──── Why this invariant matters (grounded in subtreeOutline.ts:1-11,150-173) ────
 *
 * This renders a flat `get-subtree` payload — which can carry arbitrary,
 * attacker/LLM-influenced block IDS, CONTENT, and PROPERTIES — as an
 * outline an agent (or a human at a terminal) reads back as ground truth
 * about block ids and structure. The anti-spoofing invariant (module doc
 * :162-172: "the id comes first... EVERY field is neutralized before
 * interpolation, so a block can't spill into id-less lines... line count
 * == block count") has now been defended against SEVEN missed hazard
 * classes:
 *
 *  - Unicode line separators (34a586e92, U+2028/U+2029 inside
 *    JSON.stringify'd properties)
 *  - the C0 information separators (8fcfafe42, U+001C-U+001F in raw
 *    content)
 *  - the row's OWN `id` never being passed through any neutralization at
 *    all (PR #447 review comment 3672555158 — a caller-supplied id
 *    containing a raw LF forged an extra outline line; ids are
 *    attacker-reachable via `createBlock`'s `data.id`,
 *    src/plugins/agent-runtime/commands.ts, which forwards an explicit id
 *    with no shape validation)
 *  - ESC (U+001B) and the C1 control range (U+0080-U+009F) surviving
 *    (PR #447 review comment 3672555166 — an ESC-introduced CSI "cursor
 *    next line" sequence renders a forged bullet on a new visual line even
 *    though a plain line-split still counts one line, since the CLI writes
 *    the outline straight to `process.stdout`, packages/agent-cli/src/cli.ts:727)
 *  - backspace (U+0008) surviving (PR #447 review comment 3676752551 —
 *    enough backspaces walk the terminal cursor BACK over the real
 *    `- [id] ` prefix and overwrite it on screen; this is what finally
 *    ended the enumerate-one-character-at-a-time pattern — the source now
 *    matches the FULL control-character space by construction
 *    (`CONTROL_CHAR_RUN_REGEX`/`ID_ENCODE_REGEX`, subtreeOutline.ts:92-111)
 *    rather than a growing deny-list)
 *  - lossily collapsing a caller-supplied `id` the SAME way as content
 *    (PR #447 review comment 3676752546 — an id containing a raw LF
 *    rendered with the LF replaced by the marker, which is neither
 *    reversible NOR injective: distinct ids could collapse to the same
 *    displayed token, and a consumer could no longer recover the id to
 *    address the block via `get-block`/`update-block`/`delete-block`.
 *    Fixed by giving `id` its OWN treatment — `encodeOutlineId`, a
 *    reversible, injective percent-encoding — instead of sharing
 *    `content`/`properties`'s lossy `neutralizeOutlineField` collapse)
 *  - `]` inside a hostile id colliding with the outline GRAMMAR's own
 *    closing delimiter (PR #447 review comment 3677029933 — injectivity
 *    of `encodeOutlineId` ALONE wasn't enough: `id: "a] b", content: "c"`
 *    and `id: "a", content: "b] c"` both rendered `- [a] b] c`, so a
 *    consumer had no way to tell where the id token ended. Fixed by also
 *    percent-encoding `]` in `ID_ENCODE_REGEX`, which makes the
 *    documented parse rule — id is everything between the leading `- [`
 *    and the FIRST `]` — unambiguous. `[` is deliberately left alone:
 *    under a first-`]` scan it's inert, not an opening delimiter to
 *    match.)
 *
 * `neutralizeOutlineField`/`encodeOutlineId`/`ID_ENCODE_REGEX`/
 * `CONTROL_CHAR_RUN_REGEX` aren't exported (internal helpers), so they're
 * exercised only through the public `renderSubtreeOutline` surface below.
 * `decodeOutlineId` — the one exported helper among them — is imported
 * directly, since it's the documented inverse a real consumer would call.
 *
 * ──── What the code actually does (grounded in subtreeOutline.ts) ────
 *
 * Every row becomes exactly one line:
 * `<indent>- [<id>] <content><props?>` (:201) — `content` and the
 * JSON.stringify'd `properties` (:194-199) both go through
 * `neutralizeOutlineField`, which collapses every RUN of hostile control
 * characters to a single marker (lossy — acceptable for prose). `id`
 * (:196) instead goes through `encodeOutlineId`, which percent-encodes
 * each hostile character (and `%` itself, so the mapping stays injective)
 * INDIVIDUALLY rather than collapsing runs — a lossy collapse is wrong for
 * an identifier a consumer needs to recover exactly
 * (subtreeOutline.ts:113-141's doc comment). Both draw from the SAME
 * control-character space (:49-91's doc comment): all of C0
 * (U+0000-U+001F) EXCEPT TAB (U+0009, deliberately excluded — a terminal
 * only ever advances the cursor on TAB, never moves it backward over the
 * prefix), DEL (U+007F), all of C1 (U+0080-U+009F), and the two Unicode
 * line/paragraph separators (U+2028/U+2029). `renderSubtreeOutline` joins
 * one line per (filtered-valid) row with a single LF (:203) and never
 * re-sorts (module doc :7-11) or otherwise introduces a line.
 *
 * ──── Generator design ────
 *
 * Ground truth is BY CONSTRUCTION: every generated row already satisfies
 * `isSubtreeOutlineRow` (a string `id`, :35-38), so `renderSubtreeOutline`'s
 * `.filter` (:180) never drops one — line count is checked against the
 * INPUT row count directly, never re-derived from what the renderer
 * produces. `CONTROL_CODEPOINTS` below is a FULL enumeration (not a
 * sample) of the control-character space named in subtreeOutline.ts's doc
 * comment above `CONTROL_CHAR_RUN_REGEX` (:49-91) — used both to build the
 * hostile-char soup generators AND to assert the invariant directly
 * (every one of those 66 codepoints, individually, must never survive
 * into the output) rather than checking a handful of samples, per PR #447
 * review comment 3676752551's explicit ask. `idSuffixArb` generates
 * arbitrary strings — including the same hostile-char soup as content,
 * literal `%`, and fully arbitrary Unicode — per review comment
 * 3672555158's earlier ask to stop restricting ids to `[a-zA-Z0-9_-]` (a
 * shape that could never have exposed the missing-id-neutralization bug
 * in the first place).
 */
import {describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {decodeOutlineId, renderSubtreeOutline, type SubtreeOutlineRow} from '../src/subtreeOutline'

// ──── shared building blocks ────

const range = (startInclusive: number, endInclusive: number): number[] => {
  const out: number[] = []
  for (let cp = startInclusive; cp <= endInclusive; cp++) out.push(cp)
  return out
}

/** A FULL enumeration (not a sample) of every codepoint the source's
 *  control-character space covers — mirrors subtreeOutline.ts's doc
 *  comment above `CONTROL_CHAR_RUN_REGEX` (:49-91): all of C0
 *  (U+0000-U+001F) EXCEPT TAB (U+0009), DEL (U+007F), all of C1
 *  (U+0080-U+009F), and the two Unicode line/paragraph separators
 *  (U+2028/U+2029). Used both to build the hostile-char soup below AND,
 *  in the anti-forge property, to assert directly that every one of these
 *  66 codepoints — individually — never survives into the output, rather
 *  than checking a handful of samples (PR #447 review comment
 *  3676752551). */
const CONTROL_CODEPOINTS: readonly number[] = [
  ...range(0x00, 0x08), // C0 minus TAB (U+0009 is the deliberate exclusion)
  ...range(0x0a, 0x1f),
  0x7f, // DEL
  ...range(0x80, 0x9f), // C1 (includes NEL, U+0085)
  0x2028, 0x2029, // LS, PS
]

const NEUTRALIZED_CHARS: readonly string[] = CONTROL_CODEPOINTS.map(cp => String.fromCodePoint(cp))

/** Independent-but-matching oracle for the `id` field's treatment —
 *  copied verbatim from subtreeOutline.ts's `ID_ENCODE_REGEX`: the SAME
 *  single-character (non-`+`-quantified) class plus `%` (for the
 *  encoding's own injectivity) and `]` (for the surrounding outline
 *  GRAMMAR's injectivity — PR #447 review comment 3677029933), percent-
 *  encoded via `encodeURIComponent`. Used only to PREDICT the expected
 *  `[id]` token in the anti-forge property below; the dedicated
 *  injectivity/round-trip properties further down instead exercise the
 *  REAL `encodeOutlineId` through the public `renderSubtreeOutline`
 *  surface (via `encodedIdToken`), since re-deriving expectations from a
 *  copy of the same logic can't catch a bug shared by both copies. */
// eslint-disable-next-line no-control-regex -- intentional control-char match, mirrors the source
const ID_ENCODE_REGEX = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029%\]]/g
const encodeIdOracle = (id: string): string => id.replace(ID_ENCODE_REGEX, encodeURIComponent)

/** A run of 1-3 characters from `NEUTRALIZED_CHARS` — the content/
 *  properties regex is `+`-quantified, so a run must collapse to exactly
 *  ONE marker, not one per character. */
const neutralizedCharRunArb: fc.Arbitrary<string> =
  fc.array(fc.constantFrom(...NEUTRALIZED_CHARS), {minLength: 1, maxLength: 3}).map(a => a.join(''))

/** A realistic ANSI/VT escape sequence: ESC introducing a CSI command
 *  (`ESC [ <params> <final-byte>`) — the exact shape PR #447 review
 *  comment 3672555166 flagged, an ESC-`[1E` "cursor next line" sequence.
 *  Removing the ESC introducer (which `neutralizeOutlineField` does) is
 *  what defuses it: a terminal never recognizes bare params/final-byte
 *  text as a control sequence without it, so `[1E` survives as inert text
 *  while ESC itself must not. */
const ansiEscapeSequenceArb: fc.Arbitrary<string> = fc.tuple(
  fc.integer({min: 0, max: 9}),
  fc.constantFrom('A', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'm'),
).map(([n, final]) => `${String.fromCodePoint(0x1b)}[${n}${final}`)

const benignTokenArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-zA-Z0-9 ]{0,6}$/)

/** `[`/`]` specifically — PR #447 review comment 3677029933's hazard class
 *  is NOT a control character at all, so nothing above guarantees it shows
 *  up often; `idSuffixArb`/`contentSoupArb`'s fully-arbitrary-Unicode
 *  branch could produce it, but only by chance. Mixed into the soup below
 *  so id/content bracket collisions are exercised deliberately. */
const bracketArb: fc.Arbitrary<string> = fc.constantFrom('[', ']', '][', '[]', ']]', '[[', '] ')

/** Text soup: benign tokens interleaved with neutralized-char runs,
 *  brackets, and ANSI escape sequences at random positions, incl. runs
 *  back-to-back and at the very start/end. Shared by `content`,
 *  `properties` string leaves, AND (below) `id` — all of the SAME hostile
 *  characters are relevant to every field, even though `id` is now
 *  treated differently (percent-encoded rather than collapsed) once it
 *  reaches the renderer. */
const contentSoupArb: fc.Arbitrary<string> = fc.array(
  fc.oneof(benignTokenArb, neutralizedCharRunArb, ansiEscapeSequenceArb, bracketArb),
  {maxLength: 10},
).map(parts => parts.join(''))

/** A JSON-safe leaf value for a `properties` entry — strings sometimes
 *  carrying hostile chars (the U+2028/U+2029-inside-properties bug class,
 *  34a586e92), plus plain numbers/booleans/null. No `undefined`,
 *  functions, or circular structure — those aren't JSON-safe and are out
 *  of this suite's scope (the type is `Record<string, unknown>`, but real
 *  payloads are always JSON round-tripped over the wire). */
const jsonSafeLeafArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({maxLength: 15}),
  contentSoupArb,
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
)

const jsonSafePropertiesArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string({minLength: 1, maxLength: 8}).filter(k => k !== '__proto__'),
  jsonSafeLeafArb,
  {maxKeys: 4},
)

/** Arbitrary id suffix — including the SAME hostile-char soup as content
 *  (vertical-motion chars, ESC/C1, ANSI sequences, backspace, DEL) and
 *  fully arbitrary Unicode (which can include literal `%`), per PR #447
 *  review comment 3672555158: caller-supplied ids (`createBlock`'s
 *  `data.id`) reach the renderer with no shape validation, so restricting
 *  the generator to `[a-zA-Z0-9_-]` could never have exposed the
 *  missing-id-neutralization bug. The benign shape stays in the mix so
 *  "ordinary" ids are still exercised too. */
const idSuffixArb: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9_-]{0,10}$/),
  contentSoupArb,
  fc.string({maxLength: 20}),
)

/** One row spec: id, content, and properties may all carry hostile chars;
 *  `hasDepth` toggles between the authoritative-`depth` path and the
 *  `parentId`-walk fallback (subtreeOutline.ts:188-191) — the anti-forge
 *  invariant must hold on BOTH. */
interface RowSpec {
  idSuffix: string
  content: string
  hasDepth: boolean
  depthValue: number
  properties: Record<string, unknown> | undefined
}

const rowSpecArb: fc.Arbitrary<RowSpec> = fc.record({
  idSuffix: idSuffixArb,
  content: contentSoupArb,
  hasDepth: fc.boolean(),
  depthValue: fc.integer({min: 0, max: 6}),
  properties: fc.option(jsonSafePropertiesArb, {nil: undefined}),
})

/** A list of 1-8 rows, each `isSubtreeOutlineRow`-valid by construction
 *  (index-prefixed ids are unique REGARDLESS of what `idSuffix` contains,
 *  since the `b<i>_` prefix alone already differs per row), chained
 *  parent→child so the `parentId`-walk fallback has somewhere real to
 *  walk. */
const rowsArb: fc.Arbitrary<SubtreeOutlineRow[]> = fc.array(rowSpecArb, {minLength: 1, maxLength: 8}).map(specs =>
  specs.map((spec, i) => ({
    id: `b${i}_${spec.idSuffix}`,
    parentId: i === 0 ? null : `b${i - 1}_${specs[i - 1].idSuffix}`,
    content: spec.content,
    depth: spec.hasDepth ? spec.depthValue : undefined,
    properties: spec.properties,
  })),
)

// ──── anti-forge invariant: one line per block, id leads every line, no
//      control character (from the FULL space, not a sample) survives
//      anywhere in the output ────

describe('renderSubtreeOutline — anti-forge invariant (subtreeOutline.ts:162-172,201)', () => {
  it('emits exactly one line per row, each starting with that row\'s own (encoded) [id] token, and no control character anywhere in the output', () => {
    fc.assert(
      fc.property(rowsArb, fc.boolean(), (rows, includeProperties) => {
        const outline = renderSubtreeOutline(rows, {includeProperties})

        // Exactly one line per (already-valid) input row: split on the
        // renderer's OWN join character (:203) — LF is expected exactly
        // `rows.length - 1` times as the intentional separator, so this
        // count already proves nothing else contributed an extra line
        // break.
        const lines = outline.split('\n')
        expect(lines.length, outline).toBe(rows.length)

        // The invariant, asserted DIRECTLY against the FULL space rather
        // than via samples (PR #447 review comment 3676752551): every one
        // of the 66 codepoints in `CONTROL_CODEPOINTS` — C0 minus TAB,
        // DEL, C1, LS/PS — must be absent from EVERY line, individually,
        // not just checked as a handful of boundary/interior samples.
        // This is what would have caught backspace (U+0008) before a
        // reviewer had to name it. Checked PER LINE (not against the
        // joined `outline`) because LF (U+000A) is itself one of these 66
        // codepoints — it's the renderer's OWN intentional join character
        // BETWEEN lines (already pinned by the line-count assertion
        // above), so it legitimately appears in the joined string; it
        // must never appear WITHIN a single line, which is what this
        // checks. A leaked separator or escape byte inside a line could
        // otherwise forge a visual line break or cursor motion some OTHER
        // consumer (a terminal, an LLM) honors, even though a plain LF
        // split still counts one line.
        for (const line of lines) {
          for (const cp of CONTROL_CODEPOINTS) {
            const ch = String.fromCodePoint(cp)
            expect(line.includes(ch), `line unexpectedly contains U+${cp.toString(16).padStart(4, '0')}: ${JSON.stringify(line)}`).toBe(false)
          }
        }

        // TAB (U+0009) is the one deliberate exclusion from that space —
        // confirm it's NOT swept up by an overly-broad range.
        expect(CONTROL_CODEPOINTS.includes(0x09)).toBe(false)

        // Every line's bullet is the REAL [id] token for that row, first
        // thing after the indent — content can never precede or hide it,
        // and no extra id-less line was forged from spilled content or a
        // spilled id. `id` is percent-ENCODED (not neutralized like
        // content), so the oracle here is `encodeIdOracle`, not
        // `NEUTRALIZE_REGEX`.
        lines.forEach((line, i) => {
          const afterIndent = line.replace(/^ */, '')
          const expectedId = encodeIdOracle(rows[i].id)
          expect(afterIndent.startsWith(`- [${expectedId}] `), line).toBe(true)
        })
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

// ──── collapse idempotence: re-rendering already-collapsed content is a
//      no-op (proven through the public renderSubtreeOutline surface,
//      since neutralizeOutlineField itself isn't exported) ────

describe('neutralizeOutlineField is idempotent (subtreeOutline.ts:95-104)', () => {
  it('feeding an already-rendered line\'s content back in as new content changes it no further', () => {
    fc.assert(
      fc.property(contentSoupArb, (content) => {
        const prefix = '- [x] '
        const first = renderSubtreeOutline([{id: 'x', parentId: null, content, depth: 0}])
        expect(first.startsWith(prefix)).toBe(true)
        const firstContent = first.slice(prefix.length)

        const second = renderSubtreeOutline([{id: 'x', parentId: null, content: firstContent, depth: 0}])
        expect(second.startsWith(prefix)).toBe(true)
        const secondContent = second.slice(prefix.length)

        expect(secondContent).toBe(firstContent)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

// ──── id encoding: injective + reversible (PR #447 review comment 3676752546) ────

/** Render a single depth-0 row with EMPTY content and no properties, then
 *  extract the `[id]` token by FIXED-offset slicing rather than searching
 *  for the `] ` delimiter — the id itself may legitimately render to text
 *  containing literal `[`, `]`, or spaces (none of those are in the
 *  control-character space, so `encodeOutlineId` leaves them untouched),
 *  which would make a search-based extraction ambiguous. With content
 *  fixed to `''`, the line's exact shape is `- [<id>] ` (a 3-char prefix
 *  and a 2-char suffix around the encoded id, both fixed lengths), so
 *  slicing by those fixed lengths is unambiguous regardless of what the
 *  id itself contains. This exercises the REAL `encodeOutlineId` through
 *  the public surface (`encodeOutlineId` itself isn't exported). */
const encodedIdToken = (id: string): string => {
  const outline = renderSubtreeOutline([{id, parentId: null, content: ''}])
  return outline.slice('- ['.length, outline.length - '] '.length)
}

describe('encodeOutlineId is injective — distinct ids never render the same [id] token (PR #447 review comment 3676752546)', () => {
  it('holds for arbitrary distinct ids drawn from the same hostile-char domain as content', () => {
    fc.assert(
      fc.property(
        fc.tuple(idSuffixArb, idSuffixArb).filter(([a, b]) => a !== b),
        ([idA, idB]) => {
          expect(encodedIdToken(idA)).not.toBe(encodedIdToken(idB))
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  /** The adversarial near-collision case this property exists to rule
   *  out: one id contains a REAL hostile byte (or a real `%`), the other
   *  contains the LITERAL percent-escape text that byte encodes to (e.g.
   *  an id with an actual LF vs. an id with the literal 3 characters
   *  `%0A`). These would render to the SAME token if `%` itself weren't
   *  ALSO percent-encoded — precisely PR #447 review comment 3676752546's
   *  "Percent-encode % itself too, or the encoding isn't injective." */
  it('does not collapse a real hostile byte with the LITERAL percent-escape text for that same byte', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CONTROL_CODEPOINTS, 0x25), // 0x25 = '%' itself
        fc.stringMatching(/^[a-zA-Z0-9]{0,5}$/),
        fc.stringMatching(/^[a-zA-Z0-9]{0,5}$/),
        (cp, pre, post) => {
          const hex = cp.toString(16).toUpperCase().padStart(2, '0')
          const realByteId = `${pre}${String.fromCodePoint(cp)}${post}`
          const literalEscapeId = `${pre}%${hex}${post}`
          // Sanity: the construction actually produced two DISTINCT ids —
          // otherwise this pair proves nothing about injectivity.
          expect(realByteId).not.toBe(literalEscapeId)
          expect(encodedIdToken(realByteId)).not.toBe(encodedIdToken(literalEscapeId))
        },
      ),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})

describe('decodeOutlineId is the exact inverse of encodeOutlineId (PR #447 review comment 3676752546)', () => {
  it('decodeOutlineId(encodeOutlineId(id)) === id for arbitrary ids, including hostile-char and %-bearing ones', () => {
    fc.assert(
      fc.property(idSuffixArb, (id) => {
        expect(decodeOutlineId(encodedIdToken(id))).toBe(id)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

// ──── whole-grammar round-trip + injectivity (PR #447 review comment
//      3677029933): id-alone injectivity (above) is NOT the same claim as
//      the outline GRAMMAR being unambiguous — a raw `]` inside the id
//      collides with the grammar's OWN closing delimiter regardless of
//      whether `encodeOutlineId` is injective in isolation. These
//      properties exercise the full `- [<id>] <content>` shape, not just
//      the encoder. ────

/** The parse rule `encodeOutlineId`'s doc comment (subtreeOutline.ts
 *  :113-165) commits every consumer to: the id token is everything
 *  between the leading `- [` and the FIRST `]` that follows — a
 *  first-match scan, NOT bracket-matching. `encodeOutlineId` itself isn't
 *  exported, so there's no parse HELPER to import; this implements the
 *  documented rule directly, as the inverse this suite pins (PR #447
 *  review comment 3677029933's guidance: "If a parse helper doesn't
 *  exist, write the parse rule in the test as the inverse you're
 *  pinning"). Any real consumer parsing the outline back into ids MUST
 *  follow this exact rule. */
const parseIdFromLine = (line: string): string => {
  const start = '- ['.length
  const end = line.indexOf(']', start)
  return decodeOutlineId(line.slice(start, end))
}

describe('whole-grammar round-trip: the documented first-] parse rule recovers the exact id through the FULL line, not just the encoder (PR #447 review comment 3677029933)', () => {
  it('parseIdFromLine(renderSubtreeOutline([{id, content}])) === id for arbitrary (id, content) pairs, including ids/content containing [ and ]', () => {
    fc.assert(
      fc.property(idSuffixArb, contentSoupArb, (id, content) => {
        const outline = renderSubtreeOutline([{id, parentId: null, content, depth: 0}])
        expect(parseIdFromLine(outline), outline).toBe(id)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('Codex\'s exact counterexample: an id-side ] and a content-side ] parse back to their own distinct ids', () => {
    const idHasBracket = renderSubtreeOutline([{id: 'a] b', parentId: null, content: 'c', depth: 0}])
    const contentHasBracket = renderSubtreeOutline([{id: 'a', parentId: null, content: 'b] c', depth: 0}])
    expect(idHasBracket).not.toBe(contentHasBracket)
    expect(parseIdFromLine(idHasBracket)).toBe('a] b')
    expect(parseIdFromLine(contentHasBracket)).toBe('a')
  })
})

/** Content free of the control-character space `neutralizeOutlineField`
 *  collapses (the same `CONTROL_CODEPOINTS` used above) — so
 *  `neutralizeOutlineField` is the IDENTITY on it and no lossy
 *  content-side collapse can create an independent collision. Used ONLY
 *  for the whole-LINE injectivity property below, to isolate the id/
 *  grammar fix (PR #447 review comment 3677029933) from content's
 *  separately-accepted, INTENTIONAL lossiness: two different raw content
 *  strings CAN legitimately collapse to the same neutralized text (e.g.
 *  `"x\ny"` and `"x\r\ny"` both -> `"x ⏎ y"`) — that's by design (content
 *  is prose, not an identifier), not a bug, and isn't what this property
 *  is about. May still contain `[`/`]` — those are not control characters
 *  and are never neutralized, so they don't need to be excluded here. */
const controlCharFreeContentArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-zA-Z0-9 .,!?[\]-]{0,15}$/)

describe('whole-line injectivity: distinct (id, content) pairs never render the same line, with content-side lossiness controlled for (PR #447 review comment 3677029933)', () => {
  it('holds for arbitrary distinct (id, content) pairs — id from the full hostile domain (incl. [ and ]), content control-char-free so only the id/grammar fix is under test', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.tuple(idSuffixArb, controlCharFreeContentArb),
          fc.tuple(idSuffixArb, controlCharFreeContentArb),
        ).filter(([a, b]) => a[0] !== b[0] || a[1] !== b[1]),
        ([[idA, contentA], [idB, contentB]]) => {
          const lineA = renderSubtreeOutline([{id: idA, parentId: null, content: contentA, depth: 0}])
          const lineB = renderSubtreeOutline([{id: idB, parentId: null, content: contentB, depth: 0}])
          expect(lineA).not.toBe(lineB)
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('Codex\'s exact counterexample no longer collides', () => {
    const idHasBracket = renderSubtreeOutline([{id: 'a] b', parentId: null, content: 'c', depth: 0}])
    const contentHasBracket = renderSubtreeOutline([{id: 'a', parentId: null, content: 'b] c', depth: 0}])
    expect(idHasBracket).not.toBe(contentHasBracket)
  })
})

// ──── TAB is the one deliberate allowance — verify it generically, not
//      just via the pinned unit-test example ────

describe('TAB survives content untouched — the one deliberate exclusion from the control-character space (subtreeOutline.ts:79-84)', () => {
  it('preserves every TAB in content exactly, unlike every other control character', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', ' '), {maxLength: 5}),
        fc.integer({min: 0, max: 5}),
        (tokens, tabCount) => {
          const content = tokens.join('') + String.fromCodePoint(0x09).repeat(tabCount)
          const outline = renderSubtreeOutline([{id: 'x', parentId: null, content, depth: 0}])
          const renderedContent = outline.slice('- [x] '.length)
          const renderedTabCount = [...renderedContent].filter(c => c === String.fromCodePoint(0x09)).length
          expect(renderedTabCount).toBe(tabCount)
        },
      ),
      fuzzParams(100),
    )
  }, fuzzTestTimeout())
})
