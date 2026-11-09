/**
 * Where the reader's selection in an `html-document` frame sits in the block's
 * source, and back. The source is parsed here as the frame parses it, after the
 * same head. Where the browser builds the same text nodes, a mark names its
 * node by place ({@link FrameMark}) and a selection's end by its node's text
 * and which occurrence of that text it is ({@link FramePoint}); the text
 * digest on each side says whether it did.
 *
 * Exact or refused, as read-mode markdown is (`annotations/readSelection.ts`):
 * a point maps only where the frame's text is the text the source parses to,
 * and only at a position the source spells exactly. Character references decode
 * as the tokenizer decodes them, so a point beside one maps to the reference
 * whole, and a point inside what one expands to maps nowhere.
 *
 * Loaded on demand: it carries an HTML parser.
 */

import {parse, type DefaultTreeAdapterTypes} from 'parse5'
import {DecodingMode, EntityDecoder, htmlDecodeTree} from 'entities/decode'
import type {HighlightRange} from '@/plugins/annotations/surface.ts'
import {
  asFramed,
  innerDocumentHead,
  textDigest,
  type FrameMark,
  type FrameMarks,
  type FramePoint,
  type FrameSelection,
  type MarkKind,
} from './frameDocument.ts'

type ParentNode = DefaultTreeAdapterTypes.ParentNode

export interface TextSpan {
  value: string
  /** The source offset of each position in `value`, 0 through its length, or
   *  -1 where none is exact: inside what a reference expands to, and
   *  everywhere in text the parser built some other way than by decoding its
   *  source in place (text the tree builder moved and merged, or a script's
   *  raw text, where references stay as written). */
  offsets: readonly number[]
}

const HEAD = innerDocumentHead('', null)

/** The character reference that starts at `at`, an `&`, as the tokenizer
 *  reads one in text: how much source it takes and what it decodes to. Null
 *  for an `&` that starts none. */
const referenceAt = (source: string, at: number): {length: number; text: string} | null => {
  let text = ''
  let length = 0
  const decoder = new EntityDecoder(htmlDecodeTree, (codePoint, consumed) => {
    text += String.fromCodePoint(codePoint)
    length = consumed
  })
  decoder.startEntity(DecodingMode.Legacy)
  if (decoder.write(source, at + 1) < 0) decoder.end()
  return length > 0 ? {length, text} : null
}

const nowhere = (value: string): number[] => Array<number>(value.length + 1).fill(-1)

/** Decodes `source[from, to)` as the parser decodes text, mapping each
 *  position of the result back; nowhere unless the result is `value`. */
const offsetsOf = (source: string, from: number, to: number, value: string): number[] => {
  const offsets: number[] = []
  let decoded = ''
  let at = from
  while (at < to) {
    const reference = source[at] === '&' ? referenceAt(source, at) : null
    if (reference) {
      offsets.push(at, ...Array<number>(reference.text.length - 1).fill(-1))
      decoded += reference.text
      at += reference.length
    } else if (source[at] === '\r') {
      offsets.push(at)
      decoded += '\n'
      at += source[at + 1] === '\n' ? 2 : 1
    } else {
      offsets.push(at)
      decoded += source[at]
      at++
    }
  }
  offsets.push(to)
  return decoded === value ? offsets : nowhere(value)
}

const bodyOf = (document: DefaultTreeAdapterTypes.Document): ParentNode | undefined => {
  const html = document.childNodes.find(node => node.nodeName === 'html') as ParentNode | undefined
  return html?.childNodes.find(node => node.nodeName === 'body') as ParentNode | undefined
}

interface Parsed {
  source: string
  spans: TextSpan[]
  digest: string
}

let cached: Parsed | null = null

/** The body's text nodes, in document order, as a frame's DOM holds them when
 *  the browser builds what parse5 does. A template's content is not among
 *  them, as it isn't in the DOM's. Walked without recursion: a source can
 *  nest deeper than the stack goes. parse5 takes time quadratic in nesting
 *  depth, where a browser stops nesting at 512; a source built to nest
 *  thousands deep parses slowly here, which is accepted, since it takes one
 *  written for it. */
const parsed = (source: string): Parsed => {
  if (cached?.source === source) return cached
  const framed = asFramed(source)
  const document = parse(HEAD + framed, {sourceCodeLocationInfo: true})
  const spans: TextSpan[] = []
  const body = bodyOf(document)
  const pending: DefaultTreeAdapterTypes.ChildNode[] = body ? [...body.childNodes].reverse() : []
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.nodeName === '#text') {
      const {value, sourceCodeLocation: at} = node as DefaultTreeAdapterTypes.TextNode
      spans.push({
        value,
        offsets: at ? offsetsOf(framed, at.startOffset - HEAD.length, at.endOffset - HEAD.length, value) : nowhere(value),
      })
    } else if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i])
    }
  }
  cached = {source, spans, digest: textDigest(spans.map(span => span.value))}
  return cached
}

export const textSpansOf = (source: string): TextSpan[] => parsed(source).spans

const UNPLACEABLE = 'Can’t tell exactly which part of the source that is. Start and end the selection in plain text.'
const TEXT_CHANGED = 'Can’t tell exactly which part of the source that is: the document’s text is not what its ' +
  'source parses to (a script or an edit in it changed it, or the browser built it differently). ' +
  'Only text that appears once in it can be placed.'

/** The source text node a point is in. While the frame's text has the
 *  source's digest, the kth node with this text is the kth here. Otherwise
 *  nodes may have been added, moved, split, merged or edited, so a point is
 *  placed only in text found in one node on each side: then no other passage
 *  of the source can be the one the reader selected. */
const spanOf = ({spans, digest}: Parsed, {text, occurrence, count}: FramePoint, frameDigest: string) => {
  const matching = spans.filter(span => span.value === text)
  if (frameDigest === digest) return matching[occurrence]
  return count === 1 && matching.length === 1 ? matching[0] : undefined
}

const sourceOffsetOf = (source: Parsed, point: FramePoint, frameDigest: string): number | null => {
  const offset = spanOf(source, point, frameDigest)?.offsets[point.offset]
  return offset === undefined || offset < 0 ? null : offset
}

/** The selection as a range of the source, or why it can't be one. The ends
 *  arrive in document order, so a start past its end selected no text. */
export const rangeOfSelection = (
  source: string,
  {start, end, digest}: Pick<FrameSelection, 'start' | 'end' | 'digest'>,
): {from: number; to: number} | string => {
  const ofSource = parsed(source)
  const from = sourceOffsetOf(ofSource, start, digest)
  const to = sourceOffsetOf(ofSource, end, digest)
  if (from === null || to === null) return digest === ofSource.digest ? UNPLACEABLE : TEXT_CHANGED
  return from < to ? {from, to} : 'Select some text first.'
}

const pointAt = (spans: readonly TextSpan[], offset: number): FrameMark['start'] | null => {
  for (let node = 0; node < spans.length; node++) {
    const at = spans[node].offsets.indexOf(offset)
    if (at >= 0) return {node, offset: at}
  }
  return null
}

const kindOf = ({moved, suggestion}: HighlightRange): MarkKind =>
  `${suggestion ? 'suggestion' : 'comment'}${moved ? '-moved' : ''}`

/** Each highlight as the frame draws it, with the digest of the text it was
 *  placed in. One whose end has no place in the document's text (a moved
 *  anchor that resolved inside an attribute, or inside a reference) draws
 *  nothing. */
export const marksOf = (source: string, highlights: readonly HighlightRange[]): FrameMarks => {
  const {spans, digest} = parsed(source)
  return {
    digest,
    marks: highlights.flatMap(highlight => {
      const start = pointAt(spans, highlight.from)
      const end = pointAt(spans, highlight.to)
      return start && end ? [{start, end, kind: kindOf(highlight)}] : []
    }),
  }
}
