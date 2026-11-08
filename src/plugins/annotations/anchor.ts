/**
 * Where a thread's quote sits in its target's text, recomputed from the
 * target's raw content on every read and never persisted.
 *
 * The anchor is text, not offsets: the quote, the offset it started at when it
 * was made, and up to {@link ANCHOR_CONTEXT_LENGTH} characters of context on
 * each side. All offsets are JavaScript string (UTF-16) offsets, which is what
 * CodeMirror's selection reports, so an edit-mode selection maps onto raw
 * content with no translation.
 *
 * - exact: the quote is at `quoteStart` and the windows on each side EQUAL the
 *   stored context. Equality, not "starts with", so a quote that began or
 *   ended the block must still do so. Every write requires exact.
 * - moved: the quote occurs elsewhere and its surroundings still agree with
 *   the stored context; shown, but flagged.
 * - stale: no occurrence qualifies.
 *
 * CodeMirror joins lines with `\n`, so on content holding `\r` an editor
 * selection no longer matches the raw text and every write refuses as changed;
 * that is the safe direction.
 */

import { linkFormWrapperAround, parseBlockRefs, parseReferences } from '@/plugins/references/referenceParser.js'

/** Characters of context remembered on each side of a quote. */
export const ANCHOR_CONTEXT_LENGTH = 16

/** Context characters a moved occurrence must agree on — or all of a stored
 *  context shorter than this. A one-character agreement (a shared space) is
 *  what a different occurrence of a short quote usually has. */
const MIN_CONTEXT_AGREEMENT = 4

export interface RangeAnchor {
  /** Non-empty substring of the target's raw content. */
  quote: string
  /** Where the quote began when the anchor was made. Absent on a hand-made
   *  thread, which can then only ever resolve as moved. */
  quoteStart: number | undefined
  prefix: string
  suffix: string
}

export type AnchorResolution =
  | {state: 'exact' | 'moved'; from: number; to: number}
  | {state: 'stale'}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** Does a cut at `index` fall between the two halves of a surrogate pair?
 *  A stored half would not survive the UTF-8 round trip through storage. */
const splitsPair = (content: string, index: number): boolean =>
  index > 0 && index < content.length &&
  isHighSurrogate(content.charCodeAt(index - 1)) && isLowSurrogate(content.charCodeAt(index))

/** The context window before `start`. Shrinks rather than split a pair, so the
 *  same function computes the stored prefix and the exact check's window. */
const contextBefore = (content: string, start: number): string => {
  let from = Math.max(0, start - ANCHOR_CONTEXT_LENGTH)
  if (splitsPair(content, from)) from++
  return content.slice(from, start)
}

const contextAfter = (content: string, end: number): string => {
  let to = Math.min(content.length, end + ANCHOR_CONTEXT_LENGTH)
  if (splitsPair(content, to)) to--
  return content.slice(end, to)
}

export interface Span { startIndex: number; endIndex: number }

/** Widen `[from, to)` until it cuts none of `spans`. A fixed point, so it holds
 *  for spans that overlap without nesting, not only for nested or disjoint
 *  ones. An empty selection is returned as it is. */
export const widenToSpans = (
  spans: readonly Span[],
  from: number,
  to: number,
): {from: number; to: number} => {
  if (from === to) return {from, to}
  let changed = true
  while (changed) {
    changed = false
    for (const span of spans) {
      const overlaps = span.startIndex < to && span.endIndex > from
      const covered = span.startIndex >= from && span.endIndex <= to
      if (overlaps && !covered) {
        from = Math.min(from, span.startIndex)
        to = Math.max(to, span.endIndex)
        changed = true
      }
    }
  }
  return {from, to}
}

/** Every reference span of `content` as the reference processors rewrite it:
 *  a wikilink together with the `!` of a page embed or the
 *  `[display](…)` wrapper of a link-form wikilink, since a rename can splice
 *  either as one unit. */
const referenceSpans = (content: string): Span[] => [
  ...parseReferences(content).map(span => {
    const wrapper = linkFormWrapperAround(content, span)
    if (wrapper) return {startIndex: wrapper.image ? wrapper.start - 1 : wrapper.start, endIndex: wrapper.end}
    return content[span.startIndex - 1] === '!' ? {...span, startIndex: span.startIndex - 1} : span
  }),
  ...parseBlockRefs(content),
]

const isBracket = (c: string | undefined): boolean => c === '[' || c === ']'

/** Is `index` strictly inside a run of one bracket character, or inside a
 *  surrogate pair? A quote cut there parses or encodes differently on its own:
 *  `[[[Page]]` alone is `[Page`, which would mint a page nobody wrote. */
const cutsAToken = (content: string, index: number): boolean =>
  splitsPair(content, index) ||
  (index > 0 && isBracket(content[index]) && content[index - 1] === content[index])

/** Widen a selection of `content` until it cuts no reference span (`[[…]]`,
 *  `((…))`, `!((…))`, `[label](((…)))`, and the wrappers above), no run of
 *  brackets and no surrogate pair, so the quote parses as the target's text
 *  does and the reference plugins always see whole spans. Nested wikilinks
 *  widen to the outermost. */
export const widenToReferenceSpans = (
  content: string,
  from: number,
  to: number,
): {from: number; to: number} => {
  if (from === to) return {from, to}
  const spans = referenceSpans(content)
  let widened = {from, to}
  for (;;) {
    let {from: f, to: t} = widenToSpans(spans, widened.from, widened.to)
    while (cutsAToken(content, f)) f--
    while (cutsAToken(content, t)) t++
    if (f === widened.from && t === widened.to) return widened
    widened = {from: f, to: t}
  }
}

/** The anchor for a selection of `content`, widened to whole reference spans;
 *  null for an empty selection, which comments on the whole block. */
export const captureAnchor = (content: string, from: number, to: number): RangeAnchor | null => {
  const widened = widenToReferenceSpans(content, Math.min(from, to), Math.max(from, to))
  if (widened.from === widened.to) return null
  return {
    quote: content.slice(widened.from, widened.to),
    quoteStart: widened.from,
    prefix: contextBefore(content, widened.from),
    suffix: contextAfter(content, widened.to),
  }
}

/** `quote`'s anchor captured again at `from` in `content`, or null when the
 *  capture there is other text: the range runs past the end of `content`, or a
 *  reference span `content` parses widens it. */
export const recaptureAnchor = (content: string, from: number, quote: string): RangeAnchor | null => {
  const captured = captureAnchor(content, from, from + quote.length)
  return captured?.quote === quote ? captured : null
}

/** `start` must be a position in the text: `startsWith` reads a negative or
 *  fractional one as another position than the windows slice from, so a
 *  hand-made anchor could match text it does not sit on. */
const isExactAt = (content: string, anchor: RangeAnchor, start: number): boolean =>
  Number.isInteger(start) && start >= 0 &&
  content.startsWith(anchor.quote, start) &&
  contextBefore(content, start) === anchor.prefix &&
  contextAfter(content, start + anchor.quote.length) === anchor.suffix

/** Characters of stored context that agree with the text around an occurrence
 *  at `start`, counted outward from the quote on each side. Reading past either
 *  end of `content` gives `undefined`, which ends the count. */
const contextAgreement = (content: string, anchor: RangeAnchor, start: number): number => {
  let before = 0
  while (
    before < anchor.prefix.length &&
    anchor.prefix[anchor.prefix.length - 1 - before] === content[start - 1 - before]
  ) before++
  const end = start + anchor.quote.length
  let after = 0
  while (after < anchor.suffix.length && anchor.suffix[after] === content[end + after]) after++
  return before + after
}

export const resolveAnchor = (content: string, anchor: RangeAnchor): AnchorResolution => {
  // An empty quote occurs everywhere, and `indexOf('', n)` never moves past
  // the end, so the search below would never finish.
  if (anchor.quote === '') return {state: 'stale'}
  const length = anchor.quote.length
  if (anchor.quoteStart !== undefined && isExactAt(content, anchor, anchor.quoteStart)) {
    return {state: 'exact', from: anchor.quoteStart, to: anchor.quoteStart + length}
  }
  const required = Math.min(MIN_CONTEXT_AGREEMENT, anchor.prefix.length + anchor.suffix.length)
  const hint = anchor.quoteStart ?? 0
  let best: {start: number; agreement: number} | null = null
  for (let start = content.indexOf(anchor.quote); start >= 0; start = content.indexOf(anchor.quote, start + 1)) {
    const agreement = contextAgreement(content, anchor, start)
    if (agreement < required) continue
    if (
      best === null || agreement > best.agreement ||
      (agreement === best.agreement && Math.abs(start - hint) < Math.abs(best.start - hint))
    ) best = {start, agreement}
  }
  return best === null ? {state: 'stale'} : {state: 'moved', from: best.start, to: best.start + length}
}
