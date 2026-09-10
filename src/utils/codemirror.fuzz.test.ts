// @vitest-environment node
/**
 * Fuzz suite for `clampSelectionToLength` (src/utils/codemirror.ts:17-31).
 * See `src/test/fuzz.ts` for the smoke/deep tier mechanics and
 * `docs/fuzzing.md` for conventions.
 *
 * ──── Contract under test (codemirror.ts:9-31) ────
 *
 * Clamps every range of a REMEMBERED/external `EditorSelection` into
 * `[0, docLength]` before it's dispatched against a doc that may have
 * shrunk (or been swapped) since the selection was captured. The docblock
 * names the exact regression this guards, fixed twice (11c0f10be,
 * ae7a3b188): a raw out-of-range anchor makes CodeMirror throw `"Selection
 * points outside of document"` at `EditorState.create`/dispatch time — this
 * suite confirms that empirically (below) rather than re-deriving it, and
 * makes it the primary oracle. The comment on :26-28 also flags a SECOND,
 * quieter failure mode: `checkSelection` (verified against the live
 * `@codemirror/state` source, `dist/index.cjs`) only rejects `range.to >
 * docLength` — a negative anchor/head is silently ACCEPTED into state, so
 * without clamping it would corrupt the live selection rather than throw.
 *
 * ──── Generator design ────
 *
 * `EditorSelection` has no built-in notion of a document length at
 * construction time (`SelectionRange`/`EditorSelection.range` only require
 * `from <= to`), so out-of-range or negative anchors are legitimately
 * constructible through the public API — no invariant-bypassing needed.
 * `EditorSelection.create` DOES enforce sortedness and non-overlap among
 * ranges (@codemirror/state `dist/index.cjs` ~:1458-1467, ~:1492-1506): an
 * unsorted or touching/overlapping input is silently re-sorted and MERGED,
 * which would fold multiple ranges into fewer and renumber `mainIndex` —
 * genuine CodeMirror behavior, not `clampSelectionToLength`'s. To keep the
 * properties about OUR function rather than re-deriving CodeMirror's merge
 * algorithm, `multiRangeArb` lays out ranges left-to-right with a fixed
 * gap ≥ 3, which is enough that `EditorSelection.create` always takes the
 * no-merge path for both the raw (pre-clamp) selection AND — because
 * `Math.max(0, Math.min(x, docLength))` is monotonic non-decreasing, so it
 * can only narrow, never reorder or invert, the gap between two windows —
 * the CLAMPED ranges built directly in-bounds (property "identity on an
 * already-in-bounds selection"). The general "never throws" property
 * deliberately does NOT assume the post-clamp ranges stay unmerged (a
 * heavily shrunk `docLength` can legitimately collapse several windows onto
 * the same point); it only asserts the two things `clampSelectionToLength`
 * actually promises regardless of merging: every returned range lands
 * inside `[0, docLength]`, and the result dispatches without throwing.
 *
 * Multi-range `mainIndex` preservation under a MERGE-inducing clamp is
 * deliberately left unasserted here — that outcome is governed by
 * CodeMirror's own `EditorSelection.normalized` merge/renumber algorithm,
 * not by this function, and re-deriving it in the test would test
 * CodeMirror rather than our code. The no-merge case (the realistic one:
 * a doc shrinks but distinct selections stay distinct) is covered by the
 * identity property below, and the mixed-corruption 2-range case from
 * `codemirror.test.ts` remains as a concrete example of it.
 *
 * ──── Single-range properties: spec-level, not the formula ────
 *
 * A third describe block here used to assert
 * `clamped.ranges[0].anchor === Math.max(0, Math.min(anchor, docLength))`
 * (and the same for `head`) — character-for-character the implementation
 * in codemirror.ts, spending a full fuzz budget every deep run to re-derive
 * a formula the test just copied. Replaced with three properties that hold
 * for ANY correct clamp implementation without stating the formula
 * (idempotence, direction preservation, monotonicity — each below explains
 * why it's genuinely independent) plus a few deterministic examples that
 * pin the actual numeric boundary behavior the formula produces (negative
 * anchor → 0, overlong head → docLength, docLength 0 → full collapse).
 * Note the fuzz properties below do NOT, by design, individually catch
 * every possible formula bug — e.g. dropping the lower-bound clamp
 * (`Math.max(0, …)`, keeping only `Math.min(x, docLength)`) stays
 * idempotent, direction-preserving, AND monotonic (`Math.min` alone has
 * all three properties), so none of them would flag it. The deterministic
 * "negative anchor → 0" example is what catches that specific case —
 * verified by mutation-testing exactly that change.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { EditorSelection, EditorState } from '@codemirror/state'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { clampSelectionToLength } from './codemirror.ts'

// ──── generators ────

/** `n` ranges laid out left-to-right with a gap of `GAP` between every
 *  window's `to` and the next window's `from` — comfortably enough that no
 *  two windows can ever become adjacent/overlapping after an independent,
 *  monotonic per-endpoint clamp (see docblock). Anchor/head order is
 *  randomized independently per range: CodeMirror ranges may run "forward"
 *  (anchor <= head) or "backward" (anchor > head), and clamping must
 *  preserve that direction (a monotonic transform can't invert the
 *  anchor/head order, only collapse it to an empty range). `span` is one
 *  past the last window's `to` — the smallest doc length the raw,
 *  UNCLAMPED selection is already valid against. */
const GAP = 3
const multiRangeArb: fc.Arbitrary<{
  ranges: Array<{ anchor: number; head: number }>
  mainIndex: number
  span: number
}> = fc.integer({ min: 1, max: 4 }).chain(n =>
  fc.tuple(
    fc.array(fc.integer({ min: 0, max: 8 }), { minLength: n, maxLength: n }), // window widths
    fc.array(fc.boolean(), { minLength: n, maxLength: n }), // per-range direction
    fc.integer({ min: 0, max: n - 1 }), // mainIndex
  ).map(([widths, dirs, mainIndex]) => {
    let pos = 0
    const ranges = widths.map((w, i) => {
      const from = pos
      const to = from + w
      pos = to + GAP
      return dirs[i] ? { anchor: to, head: from } : { anchor: from, head: to }
    })
    return { ranges, mainIndex, span: pos - GAP }
  }),
)

const toSelection = (ranges: Array<{ anchor: number; head: number }>, mainIndex: number) =>
  EditorSelection.create(ranges.map(r => EditorSelection.range(r.anchor, r.head)), mainIndex)

/** A single range with a deliberately wild anchor/head — large-magnitude
 *  positive AND negative values, mixed with a modest realistic range — and
 *  an independent `docLength`. Single-range keeps merge semantics out of
 *  scope entirely (a lone range can't overlap itself), isolating the
 *  formula-independent spec properties (idempotence, direction
 *  preservation, monotonicity — see below) and the deterministic
 *  boundary pins from CodeMirror's multi-range merge/sort behavior. */
const wildOffsetArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.constantFrom(0, -1, 1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
)
const singleRangeArb: fc.Arbitrary<{ anchor: number; head: number; docLength: number }> = fc.record({
  anchor: wildOffsetArb,
  head: wildOffsetArb,
  docLength: fc.integer({ min: 0, max: 10_000 }),
})

// ──── properties ────

describe('clampSelectionToLength — dispatch safety (codemirror.ts:9-16)', () => {
  it('never throws, keeps every range in [0, docLength], and the result dispatches into a real EditorState', () => {
    fc.assert(
      fc.property(
        multiRangeArb,
        fc.integer({ min: 0, max: 2000 }), // target docLength — independent of `span`, so it can shrink a lot
        ({ ranges, mainIndex, span }, targetDocLength) => {
          const selection = toSelection(ranges, mainIndex)

          // An uncaught throw here fails the property directly — no need
          // for a separate `.not.toThrow()` wrapper.
          const clamped = clampSelectionToLength(selection, targetDocLength)

          for (const r of clamped.ranges) {
            expect(r.anchor).toBeGreaterThanOrEqual(0)
            expect(r.anchor).toBeLessThanOrEqual(targetDocLength)
            expect(r.head).toBeGreaterThanOrEqual(0)
            expect(r.head).toBeLessThanOrEqual(targetDocLength)
          }

          // The regression this function exists to prevent: a stale
          // selection dispatched against the (possibly shrunk) real doc.
          expect(() => EditorState.create({
            doc: ' '.repeat(targetDocLength),
            selection: clamped,
          })).not.toThrow()

          void span // only used to size the raw selection; not asserted here
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

describe('clampSelectionToLength — identity on an already-in-bounds selection (no needless mutation)', () => {
  it('returns a selection structurally equal to the input when every range already fits', () => {
    fc.assert(
      fc.property(
        multiRangeArb,
        fc.nat({ max: 50 }), // extra slack past the last window, so docLength >= span always
        ({ ranges, mainIndex, span }, slack) => {
          const docLength = span + slack
          const selection = toSelection(ranges, mainIndex)
          const clamped = clampSelectionToLength(selection, docLength)
          expect(clamped.eq(selection)).toBe(true)
          expect(clamped.mainIndex).toBe(selection.mainIndex)
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

describe('clampSelectionToLength — single-range spec properties (negative offsets, wide range; see docblock for why these are NOT the formula)', () => {
  it('is idempotent: clamping an already-clamped selection against the same docLength changes nothing further', () => {
    fc.assert(
      fc.property(singleRangeArb, ({ anchor, head, docLength }) => {
        const selection = EditorSelection.create([EditorSelection.range(anchor, head)], 0)
        const once = clampSelectionToLength(selection, docLength)
        const twice = clampSelectionToLength(once, docLength)
        expect(twice.eq(once)).toBe(true)
        expect(twice.mainIndex).toBe(once.mainIndex)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('never inverts direction: a forward range (anchor <= head) never comes back reversed, and a reversed one (anchor > head) never comes back forward — collapsing anchor/head to equal is allowed on either side', () => {
    fc.assert(
      fc.property(singleRangeArb, ({ anchor, head, docLength }) => {
        const selection = EditorSelection.create([EditorSelection.range(anchor, head)], 0)
        const clamped = clampSelectionToLength(selection, docLength)
        const range = clamped.ranges[0]!
        if (anchor <= head) expect(range.anchor).toBeLessThanOrEqual(range.head)
        else expect(range.anchor).toBeGreaterThanOrEqual(range.head)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('is monotonic: for two raw offsets a <= b clamped against the same docLength, clamp(a) <= clamp(b)', () => {
    const clampOffset = (x: number, docLength: number): number =>
      // A single-point range (anchor === head === x) reduces
      // `clampSelectionToLength` to a one-argument function of `x` for
      // this comparison, without assuming HOW it maps x — only that
      // it's some fixed function of x we can call twice.
      clampSelectionToLength(EditorSelection.create([EditorSelection.range(x, x)], 0), docLength).ranges[0]!.anchor

    fc.assert(
      fc.property(
        fc.tuple(wildOffsetArb, wildOffsetArb).map(([x, y]): [number, number] => (x <= y ? [x, y] : [y, x])),
        fc.integer({ min: 0, max: 10_000 }),
        ([a, b], docLength) => {
          expect(clampOffset(a, docLength)).toBeLessThanOrEqual(clampOffset(b, docLength))
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

describe('clampSelectionToLength — deterministic boundary pins', () => {
  // Exact examples rather than a fuzz property: cheap, exact, and — unlike
  // the properties above — these DO catch a dropped lower-bound clamp (see
  // docblock), which is exactly why they exist alongside them rather than
  // instead of them.
  it('clamps a negative anchor to 0', () => {
    const clamped = clampSelectionToLength(EditorSelection.create([EditorSelection.range(-5, 3)], 0), 10)
    expect(clamped.ranges[0]!.anchor).toBe(0)
  })

  it('clamps a head past the document end to docLength', () => {
    const docLength = 10
    const clamped = clampSelectionToLength(
      EditorSelection.create([EditorSelection.range(2, docLength + 10)], 0),
      docLength,
    )
    expect(clamped.ranges[0]!.head).toBe(docLength)
  })

  it('collapses every range to 0 when docLength is 0', () => {
    const clamped = clampSelectionToLength(
      EditorSelection.create([EditorSelection.range(-5, -2), EditorSelection.range(50, 100)], 0),
      0,
    )
    for (const range of clamped.ranges) {
      expect(range.anchor).toBe(0)
      expect(range.head).toBe(0)
    }
  })
})
