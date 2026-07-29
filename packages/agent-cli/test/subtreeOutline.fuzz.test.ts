// @vitest-environment node
/**
 * Fuzz suite for `renderSubtreeOutline` / `neutralizeOutlineField`
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
 * ──── Why this invariant matters (grounded in subtreeOutline.ts:1-11,84-101) ────
 *
 * This renders a flat `get-subtree` payload — which can carry arbitrary,
 * attacker/LLM-influenced block IDS, CONTENT, and PROPERTIES — as an
 * outline an agent (or a human at a terminal) reads back as ground truth
 * about block ids and structure. The anti-spoofing invariant (module doc
 * :96-101: "id comes first... every field... is passed through
 * `neutralizeOutlineField`... so a block can't spill into id-less lines
 * that masquerade as child bullets or forge a fake id") has been broken
 * FOUR times by a missed hazard class, each fixed by widening the same
 * regex in `neutralizeOutlineField` (:77-82):
 *
 *   /[\r\n\v\f\u001b-\u001f\u0080-\u009f\u2028\u2029]+/g  →  ' ⏎ '
 *
 *  - Unicode line separators (34a586e92, U+2028/U+2029 inside
 *    JSON.stringify'd properties)
 *  - the C0 information separators (8fcfafe42, U+001C-U+001F in raw
 *    content)
 *  - the row's OWN `id` never being passed through the helper at all
 *    (PR #447 review comment 3672555158 — a caller-supplied id containing
 *    `\n` forged an extra outline line; ids are attacker-reachable via
 *    `createBlock`'s `data.id`, src/plugins/agent-runtime/commands.ts,
 *    which forwards an explicit id with no shape validation)
 *  - ESC (U+001B) and the C1 control range (U+0080-U+009F) surviving
 *    (PR #447 review comment 3672555166 — `\x1b[1E` is a CSI "cursor next
 *    line" sequence: the terminal renders a forged bullet on a new visual
 *    line even though `outline.split('\n')` still counts one line, since
 *    the CLI writes the outline straight to `process.stdout`,
 *    packages/agent-cli/src/cli.ts:727)
 *
 * `neutralizeOutlineField` isn't exported (an internal helper), so it's
 * exercised only through the public `renderSubtreeOutline` surface below —
 * matching the module's own boundary (:77 has no `export`).
 *
 * ──── What the code actually does (grounded in subtreeOutline.ts) ────
 *
 * Every row becomes exactly one line: `<indent>- [<id>] <content><props?>`
 * (:130) — EVERY interpolated field (`id`, `content`, and the
 * JSON.stringify'd `properties`, :124-128) is passed through the SAME
 * `neutralizeOutlineField` before being embedded, so none of them can push
 * the real id off the line, forge a second id-shaped token, or spill onto
 * a second visual line. The two paths that feed it need the full character
 * set for different reasons (:73-76): JSON.stringify already escapes
 * control chars < U+0020 (so ESC and the C0 separators are inert there)
 * but does NOT escape U+0080 and up, while raw `content`/`id` are never
 * escaped at all, so everything reaches the outline literally.
 * `renderSubtreeOutline` joins one line per (filtered-valid) row with a
 * single `\n` (:132) and never re-sorts (module doc :7-11) or otherwise
 * introduces a line.
 *
 * ──── Generator design ────
 *
 * Ground truth is BY CONSTRUCTION: every generated row already satisfies
 * `isSubtreeOutlineRow` (a string `id`, :35-38), so `renderSubtreeOutline`'s
 * `.filter` (:109) never drops one — line count is checked against the
 * INPUT row count directly, never re-derived from what the renderer
 * produces. `NEUTRALIZED_CHARS` below is copied verbatim (with the C1 range
 * sampled rather than fully enumerated — the regex matches it as one
 * contiguous span, so boundary + interior samples exercise the same code
 * path as any other codepoint in range) from the regex's character class
 * in the source (:82), read directly rather than inferred from behavior.
 * `idSuffixArb` now generates arbitrary strings — including the same
 * hostile-char soup as content, per review comment 3672555158's ask to
 * stop restricting ids to `[a-zA-Z0-9_-]` (a shape that could never have
 * exposed the missing-id-neutralization bug in the first place).
 */
import {describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {renderSubtreeOutline, type SubtreeOutlineRow} from '../src/subtreeOutline'

// ──── shared building blocks ────

/** A representative sample of every character class
 *  `neutralizeOutlineField`'s regex matches, copied verbatim from
 *  subtreeOutline.ts:82 — LF/CR/VT/FF, ESC, the four C0 information
 *  separators, a sample of the C1 control range (U+0080-U+009F, incl. its
 *  NEL alias and both boundaries), and the two Unicode line/paragraph
 *  separators. */
const NEUTRALIZED_CHARS = [
  '\r', '\n', '\v', '\f',
  '\u001b', // ESC — introduces every ANSI/VT escape sequence
  '\u001c', '\u001d', '\u001e', '\u001f',
  '\u0080', '\u0085', '\u008e', '\u009b', '\u009f', // C1 range: both boundaries + NEL + a couple of interior codepoints
  '\u2028', '\u2029',
] as const

/** Same set minus `\n` — the renderer's OWN intentional line-join
 *  character (:132), which is expected to survive (once per row boundary)
 *  and is checked separately via the line-count assertion below. */
const NON_JOIN_NEUTRALIZED_CHARS = NEUTRALIZED_CHARS.filter(c => c !== '\n')

/** Copied verbatim from subtreeOutline.ts:82 (the SAME literal quoted in
 *  the module docblock above) — an independent ground-truth oracle for
 *  what a row's `id` becomes after `neutralizeOutlineField`, applied here
 *  only to PREDICT the expected line prefix, never to check what the
 *  renderer itself accepts. */
// eslint-disable-next-line no-control-regex -- intentional control-char match, mirrors the source
const NEUTRALIZE_REGEX = /[\r\n\v\f\u001b-\u001f\u0080-\u009f\u2028\u2029]+/g

/** A run of 1-3 characters from `NEUTRALIZED_CHARS` — the regex is
 *  `+`-quantified, so a run must collapse to exactly ONE marker, not one
 *  per character. */
const neutralizedCharRunArb: fc.Arbitrary<string> =
  fc.array(fc.constantFrom(...NEUTRALIZED_CHARS), {minLength: 1, maxLength: 3}).map(a => a.join(''))

/** A realistic ANSI/VT escape sequence: ESC introducing a CSI command
 *  (`ESC [ <params> <final-byte>`) — the exact shape PR #447 review
 *  comment 3672555166 flagged, `\x1b[1E` ("cursor next line"). Removing
 *  the ESC introducer (which `neutralizeOutlineField` does) is what
 *  defuses it: a terminal never recognizes bare params/final-byte text as
 *  a control sequence without it, so `[1E` survives as inert text while
 *  ESC itself must not. */
const ansiEscapeSequenceArb: fc.Arbitrary<string> = fc.tuple(
  fc.integer({min: 0, max: 9}),
  fc.constantFrom('A', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'm'),
).map(([n, final]) => `\u001b[${n}${final}`)

const benignTokenArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-zA-Z0-9 ]{0,6}$/)

/** Text soup: benign tokens interleaved with neutralized-char runs and
 *  ANSI escape sequences at random positions, incl. runs back-to-back and
 *  at the very start/end. Shared by `content`, `properties` string
 *  leaves, AND (below) `id` — all three go through the same
 *  `neutralizeOutlineField` call in the source, so all three need the same
 *  hostile-shape coverage. */
const contentSoupArb: fc.Arbitrary<string> = fc.array(
  fc.oneof(benignTokenArb, neutralizedCharRunArb, ansiEscapeSequenceArb),
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
 *  (vertical-motion chars, ESC/C1, ANSI sequences) and fully arbitrary
 *  Unicode, per PR #447 review comment 3672555158: caller-supplied ids
 *  (`createBlock`'s `data.id`) reach the renderer with no shape
 *  validation, so restricting the generator to `[a-zA-Z0-9_-]` could never
 *  have exposed the missing-id-neutralization bug. The benign shape stays
 *  in the mix so "ordinary" ids are still exercised too. */
const idSuffixArb: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9_-]{0,10}$/),
  contentSoupArb,
  fc.string({maxLength: 20}),
)

/** One row spec: id, content, and properties may all carry hostile chars;
 *  `hasDepth` toggles between the authoritative-`depth` path and the
 *  `parentId`-walk fallback (subtreeOutline.ts:117-120) — the anti-forge
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
//      neutralized character (vertical-motion OR ESC/C1) survives
//      anywhere in the output ────

describe('renderSubtreeOutline — anti-forge invariant (subtreeOutline.ts:93-101,130)', () => {
  it('emits exactly one line per row, each starting with that row\'s own (neutralized) [id] token, and no neutralized character anywhere in the output', () => {
    fc.assert(
      fc.property(rowsArb, fc.boolean(), (rows, includeProperties) => {
        const outline = renderSubtreeOutline(rows, {includeProperties})

        // Exactly one line per (already-valid) input row: split on the
        // renderer's OWN join character (:132) — `\n` is expected exactly
        // `rows.length - 1` times as the intentional separator, so this
        // count already proves nothing else contributed an extra `\n`.
        const lines = outline.split('\n')
        expect(lines.length, outline).toBe(rows.length)

        // No OTHER neutralized character survives inside any single line
        // — stronger than the `\n`-split above: a consumer that breaks
        // lines/moves the cursor on \r, U+2028, U+2029, or an ANSI ESC
        // sequence (none of which JS's `\n`-split reacts to) must never
        // see one either, so a leaked separator or escape byte can't forge
        // a visual line break some OTHER consumer (a terminal, an LLM)
        // honors.
        for (const line of lines) {
          for (const ch of NON_JOIN_NEUTRALIZED_CHARS) {
            expect(line.includes(ch), `line unexpectedly contains ${JSON.stringify(ch)}: ${JSON.stringify(line)}`).toBe(false)
          }
        }

        // Belt-and-suspenders on the ESC/C1 claim specifically (PR #447
        // review comment 3672555166): check the FULL U+0080-U+009F span,
        // not just the sampled codepoints above — the source regex matches
        // it as one contiguous range, so every codepoint in it must be
        // gone, and ESC (U+001B, a C0 code just outside that range) must
        // be gone too.
        expect(outline.includes('\u001b'), `outline unexpectedly contains ESC: ${JSON.stringify(outline)}`).toBe(false)
        for (let cp = 0x80; cp <= 0x9f; cp++) {
          const ch = String.fromCharCode(cp)
          expect(outline.includes(ch), `outline unexpectedly contains U+${cp.toString(16).padStart(4, '0')}: ${JSON.stringify(outline)}`).toBe(false)
        }

        // Every line's bullet is the REAL (neutralized) id for that row,
        // first thing after the indent — content can never precede or
        // hide it, and no extra id-less line was forged from spilled
        // content or a spilled id.
        lines.forEach((line, i) => {
          const afterIndent = line.replace(/^ */, '')
          const expectedId = rows[i].id.replace(NEUTRALIZE_REGEX, ' ⏎ ')
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

describe('neutralizeOutlineField is idempotent (subtreeOutline.ts:77-82)', () => {
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
