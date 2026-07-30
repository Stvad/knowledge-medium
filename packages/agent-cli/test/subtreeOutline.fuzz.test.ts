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
 * == block count") has now been defended against NINE missed hazard
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
 *  - Unicode BIDI FORMATTING CONTROLS (LRM/RLM, the embedding/override
 *    formers LRE/RLE/PDF/LRO/RLO, the isolate formers LRI/RLI/FSI/PDI)
 *    surviving — PR #447 review comment 3677343389, the "Trojan
 *    Source" class (CVE-2021-42574): these reorder DISPLAYED text in a
 *    bidi-aware terminal without changing a single byte, so the `[id]`
 *    token, its closing delimiter, and adjacent content could be made
 *    to visually swap. This is why `id`'s fix stopped being an
 *    enumerated range: bidi controls are Unicode category Cf (format),
 *    a category the C0/C1 enumeration never covered — the FOURTH time
 *    this exact surface needed widening. `id` switched to percent-
 *    encoding the full `\p{C}` Unicode category (Cc/Cf/Cs/Co/Cn) instead
 *    of an enumerated list; content, at the time, kept an enumerated
 *    list — a categorical `\p{C}` cut would also have stripped ZWJ/ZWNJ
 *    (U+200D/U+200C) — Cf, but harmless (they don't reorder anything)
 *    and semantically necessary (ZWJ builds compound emoji; ZWNJ is
 *    required orthography in Persian/Hindi/etc.) — corrupting real
 *    content to defend against a risk those two don't create. Content's
 *    bidi range was hand-TRANSCRIBED from the Unicode `Bidi_Control`
 *    property's membership rather than matching the property itself.)
 *  - THAT hand transcription itself was incomplete — PR #447 review
 *    comment 3677564794: it (and this test file's mirrored
 *    `BIDI_CODEPOINTS` list, independently transcribed the SAME way)
 *    both omitted U+061C ARABIC LETTER MARK, a `Bidi_Control` member
 *    exactly as reordering-capable as the eleven that WERE listed. The
 *    fix stops copying the property's membership on EITHER side:
 *    `CONTROL_CHAR_RUN_REGEX` now matches `\p{Bidi_Control}` directly
 *    (which — being narrower than `\p{C}`/`\p{Cf}` — does NOT include
 *    ZWJ/ZWNJ, so the previous bullet's carve-out now falls out of the
 *    property for free instead of needing to be maintained by hand), and
 *    this suite's `BIDI_CODEPOINTS` is now DERIVED from that same
 *    property via `codepointsMatching` rather than re-typed — the NINTH
 *    time this exact surface needed widening, and the first time the fix
 *    was "stop transcribing, match the standard" rather than
 *    "transcribe one more character.")
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
 * (subtreeOutline.ts:113-141's doc comment). `content`/`properties` and
 * `id` draw from DIFFERENT hazard definitions: content's
 * `CONTROL_CHAR_RUN_REGEX` is a HYBRID as of PR #447 review comment
 * 3677564794 — an ENUMERATED range for the plain control-character span
 * (all of C0 (U+0000-U+001F) EXCEPT TAB (U+0009, deliberately excluded —
 * a terminal only ever advances the cursor on TAB, never moves it
 * backward over the prefix), DEL (U+007F), all of C1 (U+0080-U+009F),
 * the two Unicode line/paragraph separators (U+2028/U+2029)) UNIONED
 * with the CATEGORICAL `\p{Bidi_Control}` property for the
 * bidi-reordering hazard (PR #447 review comment 3677343389) — with
 * ZWJ/ZWNJ (U+200D/U+200C) surviving not because of a manual carve-out
 * but because `\p{Bidi_Control}` itself excludes them (they're harmless
 * — don't reorder anything — and semantically required in real text).
 * `id`'s `ID_ENCODE_REGEX` is instead fully CATEGORICAL: the full Unicode
 * `\p{C}` General_Category "Other" (Cc/Cf/Cs/Co/Cn) plus U+2028/
 * U+2029 (category Zl/Zp, sibling to "Other", not covered by `\p{C}`)
 * plus the grammar characters `%`/`]`. `renderSubtreeOutline` joins
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
 * sample) of content's hostile-character space named in subtreeOutline.ts's
 * doc comment above `CONTROL_CHAR_RUN_REGEX` — used both to build the
 * hostile-char soup generators AND to assert the invariant directly
 * (every one of those codepoints, individually, must never survive into
 * the output) rather than checking a handful of samples, per PR #447
 * review comment 3676752551's explicit ask. Its bidi-reordering portion,
 * `BIDI_CODEPOINTS`, is DERIVED from the `\p{Bidi_Control}` property via
 * `codepointsMatching` rather than hand-copied, so it can't independently
 * drift from the same property `CONTROL_CHAR_RUN_REGEX` now matches
 * directly — the exact failure mode PR #447 review comment 3677564794
 * found: the implementation's hand-enumerated bidi range and this
 * suite's PREVIOUS hand-enumerated `BIDI_CODEPOINTS` both omitted U+061C
 * ARABIC LETTER MARK, since both were independently transcribed from the
 * same source and made the same mistake. `id`'s hazard space is
 * DIFFERENT — categorical (`\p{C}`) rather than enumerated — so it gets
 * its own generators (`idCategoryHazardArb` and friends, below) and its
 * own semantic assertion (`/\p{C}/u`, matching the invariant `id`'s doc
 * comment states, not a copy of `ID_ENCODE_REGEX`). `idSuffixArb`
 * generates arbitrary strings — including the same hostile-char soup as
 * content, literal `%`, and fully arbitrary Unicode — per review comment
 * 3672555158's earlier ask to stop restricting ids to `[a-zA-Z0-9_-]` (a
 * shape that could never have exposed the missing-id-neutralization bug
 * in the first place). The anti-forge property's id assertion (and every
 * injectivity/round-trip property below it) checks the id SEMANTICALLY —
 * parse the rendered line by the documented delimiter rule, decode, and
 * compare to the INPUT id (`parseIdFromLine`, defined below) — never by
 * re-predicting the encoder's output with a copy of its character class
 * (PR #447 review comment 3677190046, P1: a copied oracle can't catch a
 * bug or omission shared by both copies — the same lesson PR #447 review
 * comment 3677564794 applied to the bidi hazard space itself).
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

/** Enumerates every codepoint for which a `u`-flagged single-codepoint
 *  regex matches — used below to DERIVE `BIDI_CODEPOINTS` from the
 *  Unicode `Bidi_Control` property itself, rather than hand-copying its
 *  membership into a list. PR #447 review comment 3677564794: the
 *  PREVIOUS version of both this test file and subtreeOutline.ts's
 *  `CONTROL_CHAR_RUN_REGEX` hand-enumerated the same bidi range, and BOTH
 *  independently omitted U+061C ARABIC LETTER MARK — two copies of the
 *  same transcription agreeing with each other proves nothing about
 *  correctness. Generating this test's expected-codepoint list from the
 *  same `\p{Bidi_Control}` property the implementation now matches
 *  directly means a future gap in either can only be a gap shared with
 *  the Unicode data itself, never a copy-paste omission the other side
 *  could have caught. Scans the full codepoint space excluding lone
 *  (unpaired) surrogates U+D800-U+DFFF, which aren't standalone
 *  codepoints `String.fromCodePoint` can represent one at a time. */
const codepointsMatching = (re: RegExp): number[] => {
  const out: number[] = []
  for (let cp = 0x0000; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue // lone surrogates aren't single codepoints
    if (re.test(String.fromCodePoint(cp))) out.push(cp)
  }
  return out
}

/** Every codepoint the Unicode `Bidi_Control` property covers — the SAME
 *  property `subtreeOutline.ts`'s `CONTROL_CHAR_RUN_REGEX` now matches
 *  directly, derived here via `codepointsMatching` instead of hand-copied
 *  (see its doc comment for why: PR #447 review comment 3677564794 found
 *  that the previous hand-enumerated pair on both sides — LRM, RLM,
 *  LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI — both omitted U+061C
 *  ARABIC LETTER MARK). Used to build the hostile-char soup below AND, in
 *  the anti-forge/bidi properties further down, to assert against the
 *  full, CURRENT membership of the property, so a future Unicode revision
 *  that adds or removes a `Bidi_Control` member is picked up automatically
 *  rather than needing a manual list edit. */
const BIDI_CODEPOINTS: readonly number[] = codepointsMatching(/\p{Bidi_Control}/u)

/** A FULL enumeration (not a sample) of every codepoint CONTENT's
 *  hostile-character space covers — mirrors subtreeOutline.ts's doc
 *  comment above `CONTROL_CHAR_RUN_REGEX`: all of C0 (U+0000-U+001F)
 *  EXCEPT TAB (U+0009), DEL (U+007F), all of C1 (U+0080-U+009F), the two
 *  Unicode line/paragraph separators (U+2028/U+2029), and every codepoint
 *  `BIDI_CODEPOINTS` above covers (the `Bidi_Control` hazard class added
 *  by PR #447 review comment 3677343389; expressed as the semantic
 *  property rather than a hand-enumerated list as of PR #447 review
 *  comment 3677564794). ZWJ/ZWNJ (U+200D/U+200C) are DELIBERATELY
 *  excluded — `\p{Bidi_Control}` itself excludes them, see `zwjZwnjArb`
 *  below for why that matters. Used both to build the hostile-char soup
 *  below AND, in the anti-forge property, to assert directly that every
 *  one of these codepoints — individually — never survives into the
 *  output, rather than checking a handful of samples (PR #447 review
 *  comment 3676752551). This is CONTENT's hazard space only — `id`'s is
 *  the categorical `\p{C}` boundary, a fundamentally different shape (see
 *  `idCategoryHazardArb` and the module docblock above). */
const CONTROL_CODEPOINTS: readonly number[] = [
  ...range(0x00, 0x08), // C0 minus TAB (U+0009 is the deliberate exclusion)
  ...range(0x0a, 0x1f),
  0x7f, // DEL
  ...range(0x80, 0x9f), // C1 (includes NEL, U+0085)
  0x2028, 0x2029, // LS, PS
  ...BIDI_CODEPOINTS, // every Unicode Bidi_Control codepoint — see its doc comment above
]

const NEUTRALIZED_CHARS: readonly string[] = CONTROL_CODEPOINTS.map(cp => String.fromCodePoint(cp))

/** Recovers the id from a rendered outline LINE by the DOCUMENTED PARSE
 *  RULE (subtreeOutline.ts's `encodeOutlineId` doc comment): after
 *  stripping the depth indent and the bullet `- [`, the id token is
 *  everything up to the FIRST `]` — a first-match scan, NOT
 *  bracket-matching — then percent-decoded via the REAL, imported
 *  `decodeOutlineId`. This is the SEMANTIC ground-truth oracle every
 *  property below relies on: it exercises the documented CONTRACT
 *  ("render, then decode, recovers the original id") through the actual
 *  renderer and the actual `decodeOutlineId`, rather than predicting what
 *  the encoder SHOULD produce with a second copy of `ID_ENCODE_REGEX`'s
 *  character class and transformation.
 *
 *  PR #447 review comment 3677190046 (P1): this replaces an earlier
 *  version of this oracle that WAS exactly that copy — an
 *  `ID_ENCODE_REGEX` literal + `encodeURIComponent` call duplicated from
 *  the source, used only to predict the id token in the anti-forge
 *  property below. A bug or a future omission mirrored in both copies
 *  (the real encoder and this one) would have stayed green; AGENTS.md's
 *  "don't add tests that just restate the code" applies directly.
 *  `encodeOutlineId`/`ID_ENCODE_REGEX` aren't exported, so there's no
 *  encode-side helper to import either — this implements only the
 *  DECODE-side parse rule, which is what any real consumer parsing the
 *  outline back into ids would also have to implement by hand. */
const parseIdFromLine = (line: string): string => {
  const afterIndent = line.replace(/^ */, '')
  const start = '- ['.length
  const end = afterIndent.indexOf(']', start)
  return decodeOutlineId(afterIndent.slice(start, end))
}

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

/** Draws from `BIDI_CODEPOINTS` (defined above, derived from
 *  `\p{Bidi_Control}` — PR #447 review comment 3677564794) — the bidi
 *  formatting controls that REORDER displayed text, PR #447 review
 *  comment 3677343389's "Trojan Source" class (CVE-2021-42574). Kept as
 *  its own arbitrary (rather than drawing from `CONTROL_CODEPOINTS`,
 *  which also includes these) so the dedicated bidi-specific properties
 *  further down can name exactly what they're testing, independent of
 *  anything else `CONTROL_CODEPOINTS` happens to contain. Also mixed into
 *  `idSuffixArb` below — for `id` these are just more `\p{C}` (Cf)
 *  characters to encode, no different from any other. */
const bidiControlArb: fc.Arbitrary<string> = fc.constantFrom(...BIDI_CODEPOINTS).map(cp => String.fromCodePoint(cp))

/** ZWJ (U+200D) / ZWNJ (U+200C) — Cf, like the bidi controls above, but
 *  the DELIBERATE OPPOSITE case: subtreeOutline.ts's
 *  `CONTROL_CHAR_RUN_REGEX` doc comment explains why content must NOT
 *  neutralize these (they don't reorder anything; ZWJ builds compound
 *  emoji, ZWNJ is required orthography in Persian/Hindi/etc. — PR #447
 *  review comment 3677343389). Used both as the must-survive case for
 *  content (below) and, mixed into `idSuffixArb`, as the CONTRAST case
 *  for `id` — unlike content, `id` has no such exception and encodes
 *  these like any other `\p{C}` character. */
const zwjZwnjArb: fc.Arbitrary<string> = fc.constantFrom(
  String.fromCodePoint(0x200d), // ZWJ
  String.fromCodePoint(0x200c), // ZWNJ
)

/** A LONE (unpaired) UTF-16 surrogate — Unicode category Cs, one of the
 *  five `\p{C}` sub-categories `id`'s `ID_ENCODE_REGEX` now covers
 *  (subtreeOutline.ts's doc comment above it). Built with `fromCharCode`
 *  (a raw UTF-16 code UNIT), not `fromCodePoint` (which throws for a
 *  value in the surrogate range) — the whole point is this is
 *  deliberately NOT a valid standalone codepoint; JS strings are
 *  unvalidated UTF-16, so a caller-supplied id can genuinely contain
 *  one. */
const loneSurrogateArb: fc.Arbitrary<string> = fc.integer({min: 0xd800, max: 0xdfff}).map(cp => String.fromCharCode(cp))

/** Private-use (Co) and unassigned (Cn) codepoints — the other two
 *  `\p{C}` sub-categories `id` covers that nothing above exercises.
 *  U+E000-U+F8FF is the BMP Private Use Area, permanently reserved and
 *  never assigned a public meaning by the Unicode Consortium. U+0378/
 *  U+0379 have been unassigned since Unicode's very first version with
 *  no pending allocation — confirmed directly against this repo's
 *  installed Node/ICU version — `/\p{Cn}/u.test(String.fromCodePoint(0x378))`
 *  is `true` — not assumed
 *  from the Unicode spec alone, since "currently unassigned" is a moving
 *  target across Unicode versions. */
const privateUseArb: fc.Arbitrary<string> = fc.integer({min: 0xe000, max: 0xf8ff}).map(cp => String.fromCodePoint(cp))
const unassignedArb: fc.Arbitrary<string> = fc.constantFrom(0x0378, 0x0379).map(cp => String.fromCodePoint(cp))

/** The `\p{C}` hazard surface `id` must encode away that the existing
 *  control-character soup doesn't reach: bidi controls, lone surrogates,
 *  private-use, and unassigned codepoints (PR #447 review comment
 *  3677343389). ZWJ/ZWNJ are deliberately a SEPARATE arbitrary
 *  (`zwjZwnjArb`) rather than folded in here — for `id` they'd be fine
 *  either way (no content-style exception applies), but keeping them
 *  separate is what lets the id-side "ZWJ/ZWNJ gets encoded, unlike in
 *  content" contrast property (below) name exactly what it draws from. */
const idCategoryHazardArb: fc.Arbitrary<string> = fc.oneof(bidiControlArb, loneSurrogateArb, privateUseArb, unassignedArb)

/** Text soup: benign tokens interleaved with neutralized-char runs,
 *  brackets, bidi controls, ZWJ/ZWNJ, and ANSI escape sequences at random
 *  positions, incl. runs back-to-back and at the very start/end. Shared
 *  by `content`, `properties` string leaves, AND (below) `id` — all of
 *  the SAME hostile characters are relevant to every field, even though
 *  `id` is now treated differently (percent-encoded rather than
 *  collapsed) once it reaches the renderer, and content's bidi/ZWJ/ZWNJ
 *  handling differs from `id`'s (see `BIDI_CODEPOINTS`/`zwjZwnjArb`
 *  above). */
const contentSoupArb: fc.Arbitrary<string> = fc.array(
  fc.oneof(benignTokenArb, neutralizedCharRunArb, ansiEscapeSequenceArb, bracketArb, bidiControlArb, zwjZwnjArb),
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
 *  "ordinary" ids are still exercised too.
 *
 *  The `fc.string()` branch explicitly sets `unit: 'binary'` — PR #447
 *  review comment 3677190053: fast-check 4.9's `fc.string()` DEFAULTS to
 *  `unit: 'grapheme-ascii'` (printable ASCII only), so an unqualified
 *  call here would have silently contradicted this comment's own "fully
 *  arbitrary Unicode" claim — the branch would only ever have emitted
 *  ASCII, and every non-ASCII codepoint actually exercised would have
 *  come from the separately hard-coded control-character soup, never
 *  from "arbitrary Unicode." `'binary'` was chosen (over `'grapheme'`/
 *  `'grapheme-composite'`) because it produces ANY codepoint in the full
 *  Unicode range (U+0000-U+10FFFF, excluding lone surrogates) regardless
 *  of printability or grapheme-combination — the closest match to what a
 *  truly unrestricted `data.id: string` could contain, including
 *  combining marks, supplementary-plane characters, and Unicode
 *  formatting characters, none of which `'grapheme-ascii'` could ever
 *  produce. It still excludes LONE surrogates by construction (fast-check's
 *  own `'binary'` doc: "except half surrogate pairs"), which is exactly
 *  why `idCategoryHazardArb` (below) generates them deliberately — `id`'s
 *  `\p{C}` boundary must cover Cs too (PR #447 review comment 3677343389).
 *
 *  `idCategoryHazardArb` and `zwjZwnjArb` are mixed in explicitly (rather
 *  than left to chance from the `'binary'` branch above) so bidi
 *  controls, lone surrogates, private-use, unassigned codepoints, and
 *  ZWJ/ZWNJ are exercised with real weight, not just whatever the random
 *  binary-unit sampler happens to land on. */
const idSuffixArb: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9_-]{0,10}$/),
  contentSoupArb,
  fc.string({maxLength: 20, unit: 'binary'}),
  idCategoryHazardArb,
  zwjZwnjArb,
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
        // of the codepoints in `CONTROL_CODEPOINTS` — C0 minus TAB, DEL,
        // C1, LS/PS, and every `\p{Bidi_Control}` codepoint (PR #447
        // review comment 3677564794) — must be absent from EVERY line,
        // individually, not just checked as a handful of boundary/
        // interior samples. This is what would have caught backspace
        // (U+0008), and would have caught the U+061C bidi-property
        // omission too had this list still been hand-copied instead of
        // derived. Checked PER LINE (not against the joined `outline`)
        // because LF (U+000A) is itself one of these codepoints — it's
        // the renderer's OWN intentional join character
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
        // spilled id. Checked SEMANTICALLY (parse by the documented
        // delimiter rule, then decode, then compare to the INPUT id) —
        // not by re-predicting the encoder's output with a copy of its
        // character class, which couldn't catch a bug shared by both
        // copies (PR #447 review comment 3677190046). This is a
        // SEPARATE assertion from the forbidden-character check above,
        // not a replacement for it.
        lines.forEach((line, i) => {
          const afterIndent = line.replace(/^ */, '')
          expect(afterIndent.startsWith('- ['), line).toBe(true)
          expect(parseIdFromLine(line), line).toBe(rows[i].id)
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
//      the encoder, reusing `parseIdFromLine` defined above (it already
//      handles a leading depth indent, which is a no-op for the
//      always-unindented single-row lines these properties render). ────

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

// ──── Trojan-Source hardening (PR #447 review comment 3677343389, refined
//      by PR #447 review comment 3677564794): id's \p{C} categorical
//      boundary, content's bidi neutralization, and the ZWJ/ZWNJ
//      preservation exception — asserted SEMANTICALLY against the
//      Unicode-standard `\p{C}`/`\p{Bidi_Control}` properties themselves,
//      never by re-deriving what `ID_ENCODE_REGEX`/`CONTROL_CHAR_RUN_REGEX`
//      should produce (the same P1 lesson as `parseIdFromLine` above: a
//      copied oracle can't catch a bug or omission shared by both copies —
//      exactly how U+061C ARABIC LETTER MARK went unnoticed the first time:
//      the implementation's hand-enumerated bidi range and this suite's
//      mirrored `BIDI_CODEPOINTS` list omitted the SAME character). ────

describe('id: the categorical \\p{C} boundary — no control/format/surrogate/private-use/unassigned character survives in a rendered id (PR #447 review comment 3677343389)', () => {
  it('/\\p{C}/u never matches the rendered [id] token, for ids drawn from bidi controls, lone surrogates, private-use, and unassigned codepoints', () => {
    fc.assert(
      fc.property(idSuffixArb, (id) => {
        const token = encodedIdToken(id)
        expect(/\p{C}/u.test(token), token).toBe(false)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  /** Non-vacuous sanity: the construction actually produces ids that DO
   *  contain a `\p{C}` character, so the property above isn't trivially
   *  true because the generator never exercises the hazard. */
  it('sanity: idCategoryHazardArb really does generate \\p{C} characters', () => {
    fc.assert(
      fc.property(idCategoryHazardArb, (hazard) => {
        expect(/\p{C}/u.test(hazard), JSON.stringify(hazard)).toBe(true)
      }),
      fuzzParams(100),
    )
  }, fuzzTestTimeout())
})

describe('no bidi formatting control survives anywhere in the rendered outline, whether it came from id or content (PR #447 review comment 3677343389)', () => {
  it('holds for arbitrary rows whose id and/or content carry bidi controls', () => {
    fc.assert(
      fc.property(rowsArb, fc.boolean(), (rows, includeProperties) => {
        const outline = renderSubtreeOutline(rows, {includeProperties})

        // Asserted TWICE, deliberately: once per named codepoint (the
        // exhaustive `BIDI_CODEPOINTS` enumeration, itself DERIVED from
        // the property rather than hand-copied — see its doc comment),
        // and once directly against the semantic `\p{Bidi_Control}`
        // property (the SAME style as the id `\p{C}` boundary test
        // above). The two are logically redundant when the derivation is
        // correct, but they fail for DIFFERENT reasons if it isn't: the
        // per-codepoint loop pins down exactly WHICH character leaked
        // (useful for debugging), while the direct property test doesn't
        // depend on `BIDI_CODEPOINTS`/`codepointsMatching` being correct
        // at all — it re-derives nothing and re-states nothing, it just
        // asks Node's own Unicode data whether a `Bidi_Control` character
        // is present (PR #447 review comment 3677564794's explicit ask:
        // "test that property rather than copying another enumeration").
        for (const cp of BIDI_CODEPOINTS) {
          const ch = String.fromCodePoint(cp)
          expect(outline.includes(ch), `outline unexpectedly contains bidi control U+${cp.toString(16).padStart(4, '0')}: ${JSON.stringify(outline)}`).toBe(false)
        }
        expect(/\p{Bidi_Control}/u.test(outline), outline).toBe(false)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('the exact Trojan-Source shape: an RLO in content can no longer visually swap the id and content halves of the line', () => {
    // U+202E (RLO) forces everything after it to render right-to-left
    // until a PDF/end-of-string — in a bidi-aware viewer this could make
    // "- [real-id] evil" DISPLAY with "evil" and "real-id" visually
    // swapped, even though the bytes never moved. Neutralizing it (like
    // any other content-side hazard) collapses it to the inert marker
    // instead.
    const outline = renderSubtreeOutline([
      {id: 'real-id', parentId: null, content: `${String.fromCodePoint(0x202e)}evil`, depth: 0},
    ])
    expect(outline).toBe('- [real-id]  ⏎ evil')
    expect(outline.includes(String.fromCodePoint(0x202e))).toBe(false)
  })

  it('the omitted member itself: U+061C ARABIC LETTER MARK in content is neutralized, not just the eleven originally-listed controls (PR #447 review comment 3677564794)', () => {
    // The concrete regression this fix closes: U+061C is a Unicode
    // `Bidi_Control` codepoint exactly like LRM/RLM/the embedding and
    // isolate formers, but the FIRST bidi fix (PR #447 review comment
    // 3677343389) hand-enumerated the class and happened to name only
    // those eleven, never this one — so this exact character used to
    // survive into rendered content unchanged. Pinned as its own
    // example (in addition to the property-driven fuzz property above)
    // so this specific omission can never silently regress even if
    // `BIDI_CODEPOINTS`'s derivation logic itself had a bug.
    const outline = renderSubtreeOutline([
      {id: 'real-id', parentId: null, content: `${String.fromCodePoint(0x061c)}evil`, depth: 0},
    ])
    expect(outline).toBe('- [real-id]  ⏎ evil')
    expect(outline.includes(String.fromCodePoint(0x061c))).toBe(false)
  })
})

describe('ZWJ/ZWNJ survive in content untouched — the deliberate exception to bidi neutralization (PR #447 review comment 3677343389)', () => {
  it('preserves every ZWJ/ZWNJ occurrence in content exactly, at any count/position', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', ' '), {maxLength: 5}),
        fc.array(zwjZwnjArb, {maxLength: 5}),
        (tokens, zwChars) => {
          const content = tokens.join('') + zwChars.join('')
          const outline = renderSubtreeOutline([{id: 'x', parentId: null, content, depth: 0}])
          const renderedContent = outline.slice('- [x] '.length)
          for (const zw of [String.fromCodePoint(0x200d), String.fromCodePoint(0x200c)]) {
            const expectedCount = zwChars.filter(c => c === zw).length
            const actualCount = [...renderedContent].filter(c => c === zw).length
            expect(actualCount, renderedContent).toBe(expectedCount)
          }
        },
      ),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())

  it('preserves ZWJ inside a realistic compound emoji sequence (family emoji) — the concrete case over-stripping would break', () => {
    // Man + ZWJ + Woman + ZWJ + Girl = one family emoji. Stripping either
    // ZWJ turns this into three SEPARATE emoji rendered side by side.
    const familyEmoji = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    const outline = renderSubtreeOutline([{id: 'x', parentId: null, content: familyEmoji, depth: 0}])
    expect(outline).toBe(`- [x] ${familyEmoji}`)
  })
})

describe('id treats ZWJ/ZWNJ like any other \\p{C} character — encoded, unlike the content-side exception above (PR #447 review comment 3677343389)', () => {
  it('percent-encodes ZWJ/ZWNJ when they appear in an id (no content-style carve-out for identifiers)', () => {
    fc.assert(
      fc.property(zwjZwnjArb, (zw) => {
        const token = encodedIdToken(`a${zw}b`)
        expect(token.includes(zw), token).toBe(false)
        expect(decodeOutlineId(token)).toBe(`a${zw}b`)
      }),
      fuzzParams(50),
    )
  }, fuzzTestTimeout())
})
