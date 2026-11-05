// @vitest-environment node
/**
 * Fuzz suite for the text anchors in `./anchor.ts`. See `src/test/fuzz.ts`
 * for smoke/deep tier mechanics and `docs/fuzzing.md` for conventions.
 *
 * Every anchor WRITE (create, re-anchor, accept a suggestion) refuses unless
 * the anchor resolves `exact` against the target in the writing tx, so the
 * properties below are the ones those gestures depend on:
 *
 * 1. Capture is sound: a non-empty selection captures an anchor that covers
 *    it, is the target's own text, cuts no reference span or surrogate pair,
 *    resolves `exact` where it was captured, and re-captures to itself
 *    (`recaptureAnchor`, which "confirm position" uses, never refuses a quote
 *    `captureAnchor` produced).
 * 2. Resolution is sound for ANY anchor (a hand-made thread carries arbitrary
 *    props): it never throws, a non-stale range is exactly the quote's text,
 *    and `exact` means at the stored start.
 * 3. An edit outside both context windows never loses the quote: before the
 *    prefix window it resolves to the quote's text, after the suffix window it
 *    stays `exact` where it was.
 * 4. A confirmed anchor (`confirmedAnchor`) is one the write path accepts.
 * 5. A split (`anchorAfterSplit`) moves a thread only to the piece holding its
 *    quote whole and keeps an exact anchor exact there. A moved anchor keeps
 *    its quote and context and only takes its piece-relative offset; it is not
 *    guaranteed to resolve in the piece, since the cut can take every context
 *    character that agreed.
 *
 * The oracles are independent of the implementation: string slicing and the
 * reference parser the reference processors themselves use.
 */
import fc from 'fast-check'
import {describe, expect, it} from 'vitest'
import {parseBlockRefs, parseReferences} from '@/plugins/references/referenceParser.js'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {ANCHOR_CONTEXT_LENGTH, captureAnchor, recaptureAnchor, resolveAnchor, type RangeAnchor} from './anchor'
import {confirmedAnchor} from './reanchor'
import {anchorAfterSplit} from './splitRetarget'

const ID = '3f2a9c1d-0000-4000-8000-000000000001'

/** Tokens biased toward the syntax the widening has to respect: brackets,
 *  wikilinks, block refs and embeds, aliased refs, astral characters. Every
 *  token is well-formed UTF-16, so any join of them is too. */
const TOKENS = [
  'a', 'b', 'c', ' ', ' ', '\n', '!', '[', ']', '(', ')', '[[', ']]', '((', '))',
  '😀', '😀', '𝒳', '星', `((${ID}))`, `!((${ID}))`, `[x](((${ID})))`, '[[Page]]', '![[Page]]',
  '[shown]([[Bee]])', ID,
]
const contentArb = fc.array(fc.constantFrom(...TOKENS), {maxLength: 40, size: 'medium'}).map(parts => parts.join(''))

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff
const splitsPair = (s: string, i: number) =>
  i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i))

const withSelection = contentArb.chain(content =>
  fc.tuple(fc.nat({max: content.length}), fc.nat({max: content.length}))
    .map(([from, to]) => ({content, from, to})))

/** Every reference span the processors see, as [start, end). */
const parsedSpans = (content: string) => [
  ...parseReferences(content).map(r => [r.startIndex, r.endIndex] as const),
  ...parseBlockRefs(content).map(r => [r.startIndex, r.endIndex] as const),
]

const referencesIn = (text: string) => ({
  aliases: parseReferences(text).map(r => r.alias),
  blockIds: parseBlockRefs(text).map(r => r.blockId),
})

describe('anchor fuzz', () => {
  it('captures a sound anchor that resolves exact where it was captured', () => {
    fc.assert(fc.property(withSelection, ({content, from, to}) => {
      const anchor = captureAnchor(content, from, to)
      if (from === to) {
        expect(anchor).toBeNull()
        return
      }
      expect(anchor).not.toBeNull()
      const {quote, quoteStart, prefix, suffix} = anchor!
      const start = quoteStart!
      const end = start + quote.length

      expect(start).toBeLessThanOrEqual(Math.min(from, to))
      expect(end).toBeGreaterThanOrEqual(Math.max(from, to))
      expect(content.slice(start, end)).toBe(quote)
      expect(content.slice(0, start).endsWith(prefix)).toBe(true)
      expect(content.slice(end).startsWith(suffix)).toBe(true)
      expect(prefix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_LENGTH)
      expect(suffix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_LENGTH)

      // No cut through a character, in the quote or either window.
      for (const cut of [start, end, start - prefix.length, end + suffix.length]) {
        expect(splitsPair(content, cut)).toBe(false)
      }
      // No cut through a reference span the processors parse.
      for (const [s, e] of parsedSpans(content)) {
        const disjoint = e <= start || s >= end
        const inside = s >= start && e <= end
        expect(disjoint || inside).toBe(true)
      }
      // The quote parses as the target does over the same range: the root's
      // content is the quote, and the reference plugins parse it on its own.
      const inside = <T extends {startIndex: number; endIndex: number}>(spans: T[]) =>
        spans.filter(s => s.startIndex >= start && s.endIndex <= end)
      expect(referencesIn(quote)).toEqual({
        aliases: inside(parseReferences(content)).map(r => r.alias),
        blockIds: inside(parseBlockRefs(content)).map(r => r.blockId),
      })

      expect(resolveAnchor(content, anchor!)).toEqual({state: 'exact', from: start, to: end})
      expect(recaptureAnchor(content, start, quote)).toEqual(anchor)
    }), fuzzParams(400))
  }, fuzzTestTimeout())

  const anyAnchorArb: fc.Arbitrary<RangeAnchor> = fc.record({
    quote: fc.oneof(contentArb, fc.constantFrom('a', ' ', '[[', '😀')),
    quoteStart: fc.oneof(
      fc.constant(undefined), fc.nat({max: 80}), fc.integer({min: -5, max: -1}), fc.double({min: 0, max: 40, noNaN: true}),
    ),
    prefix: contentArb,
    suffix: contentArb,
  })

  it('resolves any anchor to the quote text or to stale, and exact only at its stored start', () => {
    fc.assert(fc.property(contentArb, anyAnchorArb, (content, anchor) => {
      const resolved = resolveAnchor(content, anchor)
      if (resolved.state === 'stale') return
      expect(content.slice(resolved.from, resolved.to)).toBe(anchor.quote)
      if (resolved.state === 'exact') expect(resolved.from).toBe(anchor.quoteStart)
    }), fuzzParams(400))
  }, fuzzTestTimeout())

  /** A position in `content` that no character straddles. */
  const boundaryIn = (content: string, at: number): number => (splitsPair(content, at) ? at - 1 : at)

  it('keeps the quote through an edit outside both context windows', () => {
    const editArb = withSelection
      .filter(({from, to}) => from !== to)
      .chain(sel => fc.record({
        sel: fc.constant(sel),
        inserted: contentArb.filter(s => s.length > 0),
        side: fc.constantFrom('before' as const, 'after' as const),
        offset: fc.nat({max: 10}),
      }))
    fc.assert(fc.property(editArb, ({sel: {content, from, to}, inserted, side, offset}) => {
      const anchor = captureAnchor(content, from, to)!
      const start = anchor.quoteStart!
      const end = start + anchor.quote.length
      if (side === 'before') {
        const latest = start - ANCHOR_CONTEXT_LENGTH
        if (latest < 0) return
        const at = boundaryIn(content, Math.max(0, latest - offset))
        const edited = content.slice(0, at) + inserted + content.slice(at)
        const resolved = resolveAnchor(edited, anchor)
        expect(resolved.state).not.toBe('stale')
        if (resolved.state !== 'stale') expect(edited.slice(resolved.from, resolved.to)).toBe(anchor.quote)
      } else {
        const earliest = end + ANCHOR_CONTEXT_LENGTH
        if (earliest > content.length) return
        const at = boundaryIn(content, Math.min(content.length, earliest + offset))
        if (at < earliest) return
        const edited = content.slice(0, at) + inserted + content.slice(at)
        expect(resolveAnchor(edited, anchor)).toEqual({state: 'exact', from: start, to: end})
      }
    }), fuzzParams(400))
  }, fuzzTestTimeout())

  it('confirms a moved anchor only as one the write path accepts as exact', () => {
    const arb = fc.record({
      sel: withSelection.filter(({from, to}) => from !== to),
      before: contentArb,
      after: contentArb,
    })
    fc.assert(fc.property(arb, ({sel: {content, from, to}, before, after}) => {
      const anchor = captureAnchor(content, from, to)!
      const edited = before + content + after
      const confirmed = confirmedAnchor(edited, anchor)
      if (confirmed === null) return
      expect(confirmed.quote).toBe(anchor.quote)
      expect(resolveAnchor(edited, confirmed).state).toBe('exact')
    }), fuzzParams(400))
  }, fuzzTestTimeout())

  it('follows a split only into the piece holding the whole quote, exact anchors staying exact', () => {
    const arb = fc.record({
      sel: withSelection.filter(({from, to}) => from !== to),
      prefix: contentArb,
      cuts: fc.array(fc.nat(), {maxLength: 3}),
    })
    const ids = ['B', 'P1', 'P2', 'P3']
    fc.assert(fc.property(arb, ({sel: {content: original, from, to}, prefix, cuts}) => {
      const anchor = captureAnchor(original, from, to)!
      // The live text the split cut: the captured block, possibly edited in
      // front of the quote so the anchor resolves moved.
      const content = prefix + original
      const bounds = [...new Set(cuts.map(c => boundaryIn(content, c % (content.length + 1))))].sort((a, b) => a - b)
      const edges = [0, ...bounds.filter(b => b > 0 && b < content.length), content.length]
      const pieces = edges.slice(1).map((end, i) => ({blockId: ids[i]!, start: edges[i]!, end}))

      const before = resolveAnchor(content, anchor)
      const followed = anchorAfterSplit({content, pieces}, anchor)
      if (followed === null) return
      expect(before.state).not.toBe('stale')
      if (before.state === 'stale') return
      const piece = pieces.find(p => p.blockId === followed.blockId)!
      expect(piece.start).toBeLessThanOrEqual(before.from)
      expect(before.to).toBeLessThanOrEqual(piece.end)
      const pieceText = content.slice(piece.start, piece.end)
      const at = before.from - piece.start

      if (before.state === 'exact') {
        expect(followed.anchor).not.toBeNull()
        expect(resolveAnchor(pieceText, followed.anchor!)).toEqual({state: 'exact', from: at, to: at + anchor.quote.length})
      } else if (followed.anchor === null) {
        expect(resolveAnchor(pieceText, anchor)).toEqual({state: expect.any(String), from: at, to: at + anchor.quote.length})
      } else {
        expect(followed.anchor).toEqual({...anchor, quoteStart: at})
      }
    }), fuzzParams(400))
  }, fuzzTestTimeout())
})
