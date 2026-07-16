// @vitest-environment node
/**
 * Fuzz suite for the `#`-trigger text surgery in
 * `src/plugins/supertags/typeAutocomplete.ts`: `planTriggerDeletion`
 * (:184-212) and `planTriggerRestore` (:221-239). See `src/test/fuzz.ts`
 * for smoke/deep tier mechanics and `docs/fuzzing.md` for conventions.
 * Both functions are pure and synchronous over plain strings — no DB, no
 * randomness to pin, no `statefulFuzzGuard` needed (same shape as
 * `src/utils/selection.fuzz.test.ts` / `src/data/api/codecs.fuzz.test.ts`,
 * neither of which passes `fuzzTestTimeout()` to `it()` for exactly this
 * reason: nothing in the property can outrun vitest's default timeout).
 *
 * ──── Contract, grounded at the cited lines ────
 *
 * `planTriggerDeletion(doc, applyFrom, applyTo)` (:184-212) computes the
 * span to delete when a `#tag` pick is accepted, absorbing separator
 * spaces at content/line boundaries but leaving internal whitespace
 * (mid-text spaces on both sides) untouched (docblock :176-183). It never
 * looks past the current line: `lineStart`/`lineEnd` (:189-191) bound
 * every returned offset, computed from `doc.lastIndexOf('\n', ...)` /
 * `doc.indexOf('\n', ...)`. Three `while` loops do the only widening/
 * narrowing the function performs, and every one of them consumes ONLY
 * `' '` characters (:194, :197, :200) — never a non-space, never crossing
 * `lineStart`/`lineEnd`.
 *
 * `planTriggerRestore(storedContent, ctx)` (:221-239) is the failed-pick
 * fallback: exact inverse when `storedContent === ctx.docAfter` (:225,
 * "exact inverse" per the docblock at :214-220); a no-op (`null`) when
 * the deleted span is demonstrably already back at `ctx.deletionFrom`
 * (:226-229); otherwise a clamped positional insert (:230-238) that
 * NEVER touches `storedContent` outside the single insertion point
 * `pos = min(ctx.deletionFrom, storedContent.length)` — it only ever
 * splices `insert` (a leading/trailing-space-trimmed copy of
 * `ctx.deletedText`, never anything else) between
 * `storedContent.slice(0, pos)` and `storedContent.slice(pos)`.
 *
 * `TypeTagPickContext` is built exactly once, at pick time, by
 * `candidateToOption`'s `apply` (:291-311): `docBefore` = the doc before
 * the CodeMirror delete dispatch, `triggerText` = `docBefore.slice(applyFrom,
 * applyTo)`, `deletion = planTriggerDeletion(docBefore, applyFrom, applyTo)`,
 * `deletedText = docBefore.slice(deletion.from, deletion.to)`, `docAfter`
 * = the doc after deleting `[deletion.from, deletion.to)`. The properties
 * below build the same ctx by string-splicing (the mechanical equivalent
 * of the real `view.dispatch` delete) rather than driving a CodeMirror
 * `EditorView` — `restoreDeletedTextToView`'s own test
 * (`typeAutocomplete.test.ts`) already covers the view-backed path; this
 * suite is about the pure text-surgery contract.
 *
 * ──── Generators ────
 *
 * `totalityCaseArb` — arbitrary doc (ASCII + hand-picked unicode/newline
 * chars) with an arbitrary `0 <= applyFrom <= applyTo <= doc.length`
 * range, per property 1's literal spec ("for any" range). No tag
 * structure assumed — this is meant to hit the widest surface for
 * never-throws + boundary checks.
 *
 * `triggerCaseArb` — a realistic doc built from words/tags/separators
 * (multi-line via `\n` separators, unicode words/tags, and — critically —
 * a `fixedTag` reused across several tag occurrences in the SAME doc, so
 * "which `#task` is this" is always ambiguous by content alone) with the
 * chosen `[applyFrom, applyTo)` being one real tag span (`#` through the
 * end of the query word), matching what `matchHashTrigger` /
 * `typeTagCompletionSource` (:329-357) would have produced. This is the
 * generator for round-trip and drift properties, and it's what makes the
 * "wrong occurrence" hazard the `TypeTagPickContext` docblock (:147-153)
 * warns about actually reachable: `planTriggerRestore` must stay correct
 * by POSITION even when the exact same tag text appears elsewhere in the
 * doc.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import {
  planTriggerDeletion,
  planTriggerRestore,
  type TypeTagPickContext,
} from '../typeAutocomplete'

// ──── totalityCaseArb (property 1, 2): arbitrary doc + arbitrary in-range span ────

const rawCharPool = [
  'a', 'b', ' ', '\n', '\t', '#',
  'é', '日', '本', '🎉', '́', // combining acute accent, to stress code-unit vs grapheme offsets
]

const totalityDocArb = fc.oneof(
  fc.string({maxLength: 40}),
  fc.array(fc.constantFrom(...rawCharPool), {maxLength: 40}).map(chars => chars.join('')),
)

const totalityCaseArb = totalityDocArb.chain(doc =>
  fc.tuple(fc.integer({min: 0, max: doc.length}), fc.integer({min: 0, max: doc.length})).map(
    ([a, b]) => ({doc, applyFrom: Math.min(a, b), applyTo: Math.max(a, b)}),
  ),
)

/** Every real caller derives `[applyFrom, applyTo)` from a single
 *  CodeMirror `Line.text` (`typeTagCompletionSource`, :332-354:
 *  `line = state.doc.lineAt(pos)`, `match = matchHashTrigger(line.text,
 *  ...)` — `Line.text` never contains a line break), so the span never
 *  itself crosses a `\n`. Restricting to that precondition here for the
 *  line-bounds property below: with a span that already spans a line
 *  break, `lineEnd`'s own definition (:190-191, "next `\n` AT OR AFTER
 *  applyTo") can't see a break that occurred INSIDE the caller-given
 *  span, so "stays within the enclosing line" isn't a meaningful claim
 *  for that input — confirmed inert either way (`doc:'a\n',
 *  applyFrom:0, applyTo:2` returns `{from:0,to:2}` verbatim: no crash,
 *  `from<=to` holds, just not "one line" because it was never one line
 *  to begin with). Unconstrained totality (never-throws, `from<=to`) is
 *  still asserted for every range, with or without this filter. */
const singleLineCaseArb = totalityCaseArb.filter(
  ({doc, applyFrom, applyTo}) => !doc.slice(applyFrom, applyTo).includes('\n'),
)

// ──── triggerCaseArb (properties 3, 4): realistic doc with real tag spans ────

const wordArb = fc.constantFrom('hello', 'world', 'café', '日本語', 'emoji🎉', 'ok', 'z', 'notes')
const tagWordArb = fc.constantFrom('#task', '#recipe', '#rec', '#日本語', '#a', '#tag🎉', '#Area')
const separatorArb = fc.constantFrom(' ', '  ', '\n', '\n  ', ' \n', '\n\n', '')

interface Seg { text: string; isTag: boolean }

/** Segment stream where a single `fixedTag` (per generated doc) is reused
 *  across multiple tag occurrences alongside independently varied tags —
 *  the repeated-identical-tag hazard from the `TypeTagPickContext`
 *  docblock (typeAutocomplete.ts:147-153). */
const partsArb: fc.Arbitrary<Seg[]> = tagWordArb.chain(fixedTag =>
  fc.array(
    fc.oneof(
      wordArb.map((text): Seg => ({text, isTag: false})),
      fc.constant<Seg>({text: fixedTag, isTag: true}),
      tagWordArb.map((text): Seg => ({text, isTag: true})),
    ),
    {minLength: 1, maxLength: 8},
  ).filter(parts => parts.some(p => p.isTag)),
)

interface BuiltDoc { doc: string; tagSpans: Array<{from: number; to: number}> }

const buildDoc = (parts: Seg[], seps: string[]): BuiltDoc => {
  let doc = ''
  const tagSpans: Array<{from: number; to: number}> = []
  parts.forEach((p, i) => {
    const start = doc.length
    doc += p.text
    if (p.isTag) tagSpans.push({from: start, to: doc.length})
    if (i < seps.length) doc += seps[i]
  })
  return {doc, tagSpans}
}

const docWithTagsArb: fc.Arbitrary<BuiltDoc> = partsArb.chain(parts =>
  fc.array(separatorArb, {minLength: parts.length - 1, maxLength: parts.length - 1}).map(
    seps => buildDoc(parts, seps),
  ),
)

/** `{doc, applyFrom, applyTo}` where `[applyFrom, applyTo)` is exactly one
 *  real tag occurrence (`#` through end of query) — the shape
 *  `typeTagCompletionSource` hands to `candidateToOption`'s `apply`
 *  (:346-354 `from`/`to`, sliced verbatim as `triggerText` at :297). */
const triggerCaseArb = docWithTagsArb.chain(({doc, tagSpans}) =>
  fc.integer({min: 0, max: tagSpans.length - 1}).map(idx => ({
    doc,
    applyFrom: tagSpans[idx].from,
    applyTo: tagSpans[idx].to,
  })),
)

/** Build the exact `TypeTagPickContext` `candidateToOption`'s `apply`
 *  builds (typeAutocomplete.ts:296-311), via string splicing instead of a
 *  live `EditorView` dispatch (the two are equivalent for `doc.toString()`
 *  before/after a `{from, to, insert: ''}` change). */
const buildCtx = (docBefore: string, applyFrom: number, applyTo: number): TypeTagPickContext => {
  const triggerText = docBefore.slice(applyFrom, applyTo)
  const deletion = planTriggerDeletion(docBefore, applyFrom, applyTo)
  const deletedText = docBefore.slice(deletion.from, deletion.to)
  const docAfter = docBefore.slice(0, deletion.from) + docBefore.slice(deletion.to)
  return {triggerText, at: applyFrom, deletedText, deletionFrom: deletion.from, docBefore, docAfter}
}

describe('planTriggerDeletion', () => {
  it('never throws for any 0<=from<=to<=doc.length, and always returns from<=to (typeAutocomplete.ts:184-212)', () => {
    fc.assert(
      fc.property(totalityCaseArb, ({doc, applyFrom, applyTo}) => {
        let result: {from: number; to: number} | undefined
        expect(() => { result = planTriggerDeletion(doc, applyFrom, applyTo) }).not.toThrow()
        expect(result!.from).toBeLessThanOrEqual(result!.to)
      }),
      fuzzParams(300),
    )
  })

  it('stays within the enclosing line, for spans that are themselves within one line (typeAutocomplete.ts:189-191, caller invariant at typeAutocomplete.ts:332-354)', () => {
    fc.assert(
      fc.property(singleLineCaseArb, ({doc, applyFrom, applyTo}) => {
        const {from, to} = planTriggerDeletion(doc, applyFrom, applyTo)

        // Semantically, the deleted span never crosses a line break — a
        // `#tag` command can't eat a whole separate line (docblock
        // :176-183 scopes the widening to spaces "at the start or end
        // of content" on ONE line).
        expect(doc.slice(from, to).includes('\n')).toBe(false)

        // Numeric restatement of the same bound, via an INDEPENDENT
        // "start/end of the line containing this offset" model (position
        // right after the nearest preceding '\n', or doc start/end) —
        // NOT `doc.lastIndexOf('\n', applyFrom - 1) + 1` verbatim as
        // :189 has it: `String.prototype.lastIndexOf` clamps a negative
        // `fromIndex` to 0 (confirmed: `'\n'.lastIndexOf('\n', -1) ===
        // 0`), so at `applyFrom === 0` that literal expression finds a
        // '\n' sitting AT position 0 and misreports lineStart as 1 —
        // inert in the source (the `left` while-loop guard `left >
        // lineStart` is already false at `left === applyFrom === 0`
        // whether lineStart reads 0 or 1, since `left` starts at
        // `applyFrom` and this branch never has a loop that could
        // underflow past it), but a genuine bug in reusing that
        // expression as a test oracle — this reimplementation avoids it.
        const lineStart = applyFrom === 0 ? 0 : doc.lastIndexOf('\n', applyFrom - 1) + 1
        const nextBreak = doc.indexOf('\n', applyTo)
        const lineEnd = nextBreak === -1 ? doc.length : nextBreak
        expect(from).toBeGreaterThanOrEqual(lineStart)
        expect(to).toBeLessThanOrEqual(lineEnd)
      }),
      fuzzParams(300),
    )
  })

  it('conserves everything outside [applyFrom,applyTo) it touches, widening or narrowing only across spaces (typeAutocomplete.ts:193-200)', () => {
    fc.assert(
      fc.property(totalityCaseArb, ({doc, applyFrom, applyTo}) => {
        const {from, to} = planTriggerDeletion(doc, applyFrom, applyTo)

        // The left edge only ever moves earlier (or stays put) — none of
        // the three branches that touch `from` can move it past
        // `applyFrom` (:196-197, :206-211).
        expect(from).toBeLessThanOrEqual(applyFrom)
        if (from < applyFrom) expect(doc.slice(from, applyFrom)).toMatch(/^ +$/)

        // The right edge can widen (:199-200, absorbing trailing
        // separator spaces) or narrow (:193-194, dropping trailing
        // command spaces already inside [applyFrom,applyTo)) — whichever
        // direction it moves, the crossed span is spaces only.
        if (to > applyTo) expect(doc.slice(applyTo, to)).toMatch(/^ +$/)
        if (to < applyTo) expect(doc.slice(to, applyTo)).toMatch(/^ +$/)
      }),
      fuzzParams(300),
    )
  })
})

describe('planTriggerRestore', () => {
  it('is the exact inverse of the delete when stored content still matches the post-deletion snapshot (typeAutocomplete.ts:225, ctx built as candidateToOption:296-311)', () => {
    fc.assert(
      fc.property(triggerCaseArb, ({doc, applyFrom, applyTo}) => {
        const ctx = buildCtx(doc, applyFrom, applyTo)
        expect(planTriggerRestore(ctx.docAfter, ctx)).toBe(ctx.docBefore)
      }),
      fuzzParams(300),
    )
  })

  it('on drifted content (unrelated edits to docAfter), never corrupts text outside its insertion point (typeAutocomplete.ts:227-238)', () => {
    const editArb = fc.record({
      pos: fc.nat(),
      insertText: fc.string({maxLength: 5}),
      delLen: fc.nat({max: 5}),
      isDelete: fc.boolean(),
    })
    const driftCaseArb = fc.record({
      trigger: triggerCaseArb,
      edit: editArb,
    })

    fc.assert(
      fc.property(driftCaseArb, ({trigger: {doc, applyFrom, applyTo}, edit}) => {
        const ctx = buildCtx(doc, applyFrom, applyTo)

        // An "unrelated edit" to docAfter: insert or delete somewhere,
        // possibly overlapping the old deletion point, possibly not —
        // exactly the drift `planTriggerRestore`'s fallback branches
        // exist to tolerate.
        const pos0 = Math.min(edit.pos, ctx.docAfter.length)
        const storedContent = edit.isDelete
          ? ctx.docAfter.slice(0, pos0) + ctx.docAfter.slice(pos0 + Math.min(edit.delLen, ctx.docAfter.length - pos0))
          : ctx.docAfter.slice(0, pos0) + edit.insertText + ctx.docAfter.slice(pos0)

        let raw: string | null = null
        expect(() => { raw = planTriggerRestore(storedContent, ctx) }).not.toThrow()
        // TS can't see the closure assignment above, so re-widen the type.
        const result = raw as string | null

        // `null` means "leave storedContent exactly as-is" — trivially
        // no corruption (:226-229, the demonstrably-already-there no-op).
        if (result === null) return

        // String branch (:230-238): the ENTIRE effect is inserting one
        // span at `pos`; everything before and after it is byte-identical
        // to storedContent, regardless of how the insert itself was
        // trimmed — this is the conservation law, not a restatement of
        // which spaces get trimmed.
        const pos = Math.min(ctx.deletionFrom, storedContent.length)
        const suffixLen = storedContent.length - pos
        expect(result.slice(0, pos)).toBe(storedContent.slice(0, pos))
        expect(result.slice(result.length - suffixLen)).toBe(storedContent.slice(pos))

        // The spliced-in middle is never anything other than
        // `ctx.deletedText` with (at most) a leading and/or trailing run
        // of spaces stripped (:231-237) — so it's always a substring of
        // `deletedText`, never foreign or reordered text.
        const middle = result.slice(pos, result.length - suffixLen)
        expect(ctx.deletedText.includes(middle)).toBe(true)
      }),
      fuzzParams(300),
    )
  })
})
