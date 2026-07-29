// @vitest-environment node
/**
 * Fuzz suite for `renderSubtreeOutline` / `collapseVerticalMotion`
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
 * ──── Why this invariant matters (grounded in subtreeOutline.ts:1-11,68-85) ────
 *
 * This renders a flat `get-subtree` payload — which can carry arbitrary,
 * attacker/LLM-influenced block CONTENT and PROPERTIES — as an outline an
 * agent reads back as ground truth about block ids and structure. The
 * anti-spoofing invariant (module doc :77-85: "id comes first... every
 * vertical-break character... is collapsed... so a block can't spill into
 * id-less lines that masquerade as child bullets") has been broken twice by
 * a missed vertical-motion character class: Unicode line separators
 * (34a586e92, U+2028/U+2029 inside JSON.stringify'd properties) and the C0
 * information separators (8fcfafe42, U+001C-U+001F in raw content). Both
 * fixes widened the SAME regex, `collapseVerticalMotion` (:61-66):
 *
 *   /[\r\n\v\f\u001c-\u001f\u0085\u2028\u2029]+/g  →  ' ⏎ '
 *
 * `collapseVerticalMotion` isn't exported (an internal helper), so it's
 * exercised only through the public `renderSubtreeOutline` surface below —
 * matching the module's own boundary (:61 has no `export`).
 *
 * ──── What the code actually does (grounded in subtreeOutline.ts) ────
 *
 * Every row becomes exactly one line: `<indent>- [<id>] <content><props?>`
 * (:113) — the id is a LITERAL template segment right after the bullet, so
 * it can never be pushed off the line or hidden by content. `content` (raw)
 * and the JSON.stringify'd `properties` (:111) are BOTH passed through
 * `collapseVerticalMotion` before being embedded (:108,111) — the two paths
 * need the full character set for different reasons (:54-58): JSON.stringify
 * already escapes control chars < U+0020 (so the C0 separators are inert
 * there) but does NOT escape U+0085/U+2028/U+2029 (all ≥ U+0080), while raw
 * content is never escaped at all, so the C0 separators reach it literally.
 * `renderSubtreeOutline` joins one line per (filtered-valid) row with a
 * single `\n` (:115) and never re-sorts (module doc :7-11) or otherwise
 * introduces a line.
 *
 * ──── Generator design ────
 *
 * Ground truth is BY CONSTRUCTION: every generated row already satisfies
 * `isSubtreeOutlineRow` (a string `id`, :35-38), so `renderSubtreeOutline`'s
 * `.filter` (:93) never drops one — line count is checked against the
 * INPUT row count directly, never re-derived from what the renderer
 * produces. `VERTICAL_MOTION_CHARS` below is copied verbatim from the
 * regex's character class in the source (:66), read directly rather than
 * inferred from behavior.
 */
import {describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {renderSubtreeOutline, type SubtreeOutlineRow} from '../src/subtreeOutline'

// ──── shared building blocks ────

/** Every character `collapseVerticalMotion`'s regex matches, copied
 *  verbatim from subtreeOutline.ts:66 — LF/CR/VT/FF, the four C0
 *  information separators, NEL, and the two Unicode line/paragraph
 *  separators (the two classes whose omission were the real bugs). */
const VERTICAL_MOTION_CHARS = [
  '\r', '\n', '\v', '\f',
  '\u001c', '\u001d', '\u001e', '\u001f',
  '\u0085', '\u2028', '\u2029',
] as const

/** Same set minus `\n` — the renderer's OWN intentional line-join
 *  character (:115), which is expected to survive (once per row boundary)
 *  and is checked separately via the line-count assertion below. */
const NON_JOIN_VERTICAL_MOTION_CHARS = VERTICAL_MOTION_CHARS.filter(c => c !== '\n')

/** A run of 1-3 vertical-motion characters — the regex is `+`-quantified,
 *  so a run must collapse to exactly ONE marker, not one per character. */
const verticalMotionRunArb: fc.Arbitrary<string> =
  fc.array(fc.constantFrom(...VERTICAL_MOTION_CHARS), {minLength: 1, maxLength: 3}).map(a => a.join(''))

const benignTokenArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-zA-Z0-9 ]{0,6}$/)

/** Text soup: benign tokens interleaved with vertical-motion runs at random
 *  positions, incl. runs back-to-back and at the very start/end. */
const contentSoupArb: fc.Arbitrary<string> = fc.array(
  fc.oneof(benignTokenArb, verticalMotionRunArb),
  {maxLength: 10},
).map(parts => parts.join(''))

/** A JSON-safe leaf value for a `properties` entry — strings sometimes
 *  carrying vertical-motion chars (the U+2028/U+2029-inside-properties bug
 *  class, 34a586e92), plus plain numbers/booleans/null. No `undefined`,
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

const idArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/)

/** One row spec: content and properties may carry vertical-motion chars;
 *  `hasDepth` toggles between the authoritative-`depth` path and the
 *  `parentId`-walk fallback (subtreeOutline.ts:101-104) — the anti-forge
 *  invariant must hold on BOTH. */
interface RowSpec {
  idSuffix: string
  content: string
  hasDepth: boolean
  depthValue: number
  properties: Record<string, unknown> | undefined
}

const rowSpecArb: fc.Arbitrary<RowSpec> = fc.record({
  idSuffix: idArb,
  content: contentSoupArb,
  hasDepth: fc.boolean(),
  depthValue: fc.integer({min: 0, max: 6}),
  properties: fc.option(jsonSafePropertiesArb, {nil: undefined}),
})

/** A list of 1-8 rows, each `isSubtreeOutlineRow`-valid by construction
 *  (index-prefixed ids are unique), chained parent→child so the
 *  `parentId`-walk fallback has somewhere real to walk. */
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
//      vertical-motion character survives anywhere in the output ────

describe('renderSubtreeOutline — anti-forge invariant (subtreeOutline.ts:77-85,113)', () => {
  it('emits exactly one line per row, each starting with that row\'s own [id] token, and no vertical-motion char anywhere in the output', () => {
    fc.assert(
      fc.property(rowsArb, fc.boolean(), (rows, includeProperties) => {
        const outline = renderSubtreeOutline(rows, {includeProperties})

        // Exactly one line per (already-valid) input row: split on the
        // renderer's OWN join character (:115) — `\n` is expected exactly
        // `rows.length - 1` times as the intentional separator, so this
        // count already proves nothing else contributed an extra `\n`.
        const lines = outline.split('\n')
        expect(lines.length, outline).toBe(rows.length)

        // No OTHER vertical-motion character survives inside any single
        // line — stronger than the `\n`-split above: a consumer that
        // breaks lines on \r, U+2028, or U+2029 (which JS's `\n`-split
        // does not) must never see one either, so a leaked separator
        // can't forge a visual line break some OTHER consumer honors.
        for (const line of lines) {
          for (const ch of NON_JOIN_VERTICAL_MOTION_CHARS) {
            expect(line.includes(ch), `line unexpectedly contains ${JSON.stringify(ch)}: ${JSON.stringify(line)}`).toBe(false)
          }
        }

        // Every line's bullet is the REAL id for that row, first thing
        // after the indent — content can never precede or hide it, and no
        // extra id-less line was forged from spilled content.
        lines.forEach((line, i) => {
          const afterIndent = line.replace(/^ */, '')
          expect(afterIndent.startsWith(`- [${rows[i].id}] `), line).toBe(true)
        })
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

// ──── collapse idempotence: re-rendering already-collapsed content is a
//      no-op (proven through the public renderSubtreeOutline surface,
//      since collapseVerticalMotion itself isn't exported) ────

describe('collapseVerticalMotion is idempotent (subtreeOutline.ts:61-66)', () => {
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
