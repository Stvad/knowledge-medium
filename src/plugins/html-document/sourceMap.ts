/**
 * Where the reader's selection in an `html-document` frame sits in the block's
 * source, and back. The source is parsed here as the frame parses it, after the
 * same head, so a held document's body text nodes are these, in this order: a
 * mark names its node by place ({@link FrameMark}), and a selection's end by
 * its node's text and which occurrence of that text it is ({@link FramePoint}).
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
import type {SurfaceHighlight} from '@/plugins/annotations/surface.ts'
import {asFramed, innerDocumentHead, type FrameMark, type FramePoint, type MarkKind} from './frameDocument.ts'

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
    if (reference && at + reference.length <= to) {
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

let cached: {source: string; spans: TextSpan[]} | null = null

/** The body's text nodes, in document order, as the frame's DOM holds them. A
 *  template's content is not among them, as it isn't in the DOM's. */
export const textSpansOf = (source: string): TextSpan[] => {
  if (cached?.source === source) return cached.spans
  const framed = asFramed(source)
  const document = parse(HEAD + framed, {sourceCodeLocationInfo: true})
  const spans: TextSpan[] = []
  const visit = (parent: ParentNode) => {
    for (const node of parent.childNodes) {
      if (node.nodeName === '#text') {
        const {value, sourceCodeLocation: at} = node as DefaultTreeAdapterTypes.TextNode
        spans.push({
          value,
          offsets: at ? offsetsOf(framed, at.startOffset - HEAD.length, at.endOffset - HEAD.length, value) : nowhere(value),
        })
      } else if ('childNodes' in node) {
        visit(node)
      }
    }
  }
  const body = bodyOf(document)
  if (body) visit(body)
  cached = {source, spans}
  return spans
}

const UNPLACEABLE = 'Can’t tell exactly which part of the source that is. Start and end the selection in plain text.'

const spanOf = (spans: readonly TextSpan[], {text, occurrence}: FramePoint): TextSpan | undefined => {
  let seen = 0
  return spans.find(span => span.value === text && seen++ === occurrence)
}

const sourceOffsetOf = (spans: readonly TextSpan[], point: FramePoint): number | null => {
  const offset = spanOf(spans, point)?.offsets[point.offset]
  return offset === undefined || offset < 0 ? null : offset
}

/** The selection as a range of the source, or why it can't be one. The ends
 *  arrive in document order, so a start past its end selected no text. */
export const rangeOfSelection = (
  spans: readonly TextSpan[],
  {start, end}: {start: FramePoint; end: FramePoint},
): {from: number; to: number} | string => {
  const from = sourceOffsetOf(spans, start)
  const to = sourceOffsetOf(spans, end)
  if (from === null || to === null) return UNPLACEABLE
  return from < to ? {from, to} : 'Select some text first.'
}

const pointAt = (spans: readonly TextSpan[], offset: number): FrameMark['start'] | null => {
  for (let node = 0; node < spans.length; node++) {
    const at = spans[node].offsets.indexOf(offset)
    if (at >= 0) return {node, offset: at}
  }
  return null
}

const kindOf = ({moved, suggestion}: SurfaceHighlight): MarkKind =>
  `${suggestion ? 'suggestion' : 'comment'}${moved ? '-moved' : ''}`

/** Each highlight as the frame draws it. One whose end has no place in the
 *  document's text (a moved anchor that resolved inside an attribute, or
 *  inside a reference) draws nothing. */
export const marksOf = (spans: readonly TextSpan[], highlights: readonly SurfaceHighlight[]): FrameMark[] =>
  highlights.flatMap(highlight => {
    const start = pointAt(spans, highlight.from)
    const end = pointAt(spans, highlight.to)
    return start && end ? [{start, end, kind: kindOf(highlight)}] : []
  })
