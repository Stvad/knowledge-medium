/**
 * Read-mode highlights: each open thread's quote, marked in the rendered
 * markdown by a remark transform that runs before the reference plugins.
 *
 * A quote is raw-content offsets; the rendered tree knows only the source
 * span of each node. The mapping is exact or it is not drawn:
 *
 * - a text node whose value IS its source slice is split at the range's
 *   boundaries;
 * - any other leaf (inline code, an image, text whose value differs from its
 *   source because of an escape or an entity) is marked whole, and a range
 *   that cuts one is not drawn;
 * - a range that cuts a reference span is not drawn either, so the reference
 *   plugins after this one always see whole spans;
 * - only phrasing content is wrapped; a covered paragraph or list item is
 *   marked inside.
 *
 * GFM's autolink literal splits text at parse time and leaves the pieces with
 * no position. Their spans are recovered by alignment against the source,
 * accepted only where the pieces' text equals the source slice they would
 * cover, and kept to this transform: a node it does not split keeps the
 * position the parser gave it, absent or not.
 *
 * Neighbouring marked nodes share one mark, so a span the parser split across
 * siblings (`[[` + an autolink + `]]`) stays under one parent for the
 * reference plugins to reassemble.
 */

import type {Parent, Root, RootContent} from 'mdast'
import type {Plugin} from 'unified'
import type {MarkdownExtension} from '@/markdown/extensions.js'
import {widenToReferenceSpans} from './anchor.ts'
import {HIGHLIGHT_CLASS, highlightRanges, MOVED_HIGHLIGHT_CLASS, type HighlightRange} from './highlights.ts'
import type {ThreadSummary} from './summaries.ts'

export const ANNOTATION_MARK_NODE = 'annotationMark'

type Position = NonNullable<RootContent['position']>
type Point = Position['start']

/** The editor's highlight, in utilities: plugins ship no stylesheet. */
const MARK_CLASSES = ['bg-yellow-400/30', 'text-inherit', 'border-b-2', 'border-yellow-600/75', 'dark:bg-yellow-400/20']

interface Span {
  from: number
  to: number
}

/** One stretch of source covered by the same highlight style. */
interface Segment extends Span {
  moved: boolean
}

/** The covered stretches, disjoint and in order. Where an exact and a moved
 *  range overlap, the exact style wins: the text there is certainly quoted. */
const segmentsOf = (ranges: readonly HighlightRange[]): Segment[] => {
  const cuts = [...new Set(ranges.flatMap(r => [r.from, r.to]))].sort((a, b) => a - b)
  const segments: Segment[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]
    const to = cuts[i + 1]
    const covering = ranges.filter(r => r.from <= from && r.to >= to)
    if (covering.length === 0) continue
    const moved = covering.every(r => r.moved)
    const last = segments[segments.length - 1]
    if (last && last.to === from && last.moved === moved) last.to = to
    else segments.push({from, to, moved})
  }
  return segments
}

type Coverage = {kind: 'none'} | {kind: 'whole'; moved: boolean} | {kind: 'partial'}

const coverageOf = (segments: readonly Segment[], {from, to}: Span): Coverage => {
  const touching = segments.filter(s => s.from < to && s.to > from)
  if (touching.length === 0) return {kind: 'none'}
  const [only] = touching
  return touching.length === 1 && only.from <= from && only.to >= to
    ? {kind: 'whole', moved: only.moved}
    : {kind: 'partial'}
}

const hasChildren = (node: RootContent | Root): node is (RootContent & Parent) | Root =>
  Array.isArray((node as {children?: unknown}).children)

/** Containers whose children are phrasing content, the only place a mark can
 *  sit. */
const PHRASING_PARENTS = new Set(['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference'])

const parsedSpan = (node: RootContent | Root): Span | null => {
  const from = node.position?.start.offset
  const to = node.position?.end.offset
  return from === undefined || to === undefined ? null : {from, to}
}

/** The source text a positionless node stands for, where it is knowable: text
 *  is itself, and an autolink literal is its one text child. */
const literalSource = (node: RootContent): string | null => {
  if (node.type === 'text') return node.value
  if (node.type === 'link' && node.children.length === 1 && node.children[0].type === 'text') {
    const text = node.children[0].value
    const url = node.url ?? ''
    if ([text, `mailto:${text}`, `http://${text}`, `https://${text}`].includes(url)) return text
  }
  return null
}

/** Every node's span: the parser's, or one recovered for a run of positionless
 *  siblings. A run is placed against the positioned sibling after it (or the
 *  parent's end), or else the one before it, and kept only if the source
 *  there spells exactly the run's text. */
const spansOf = (tree: Root, source: string): WeakMap<object, Span> => {
  const spans = new WeakMap<object, Span>()
  const visit = (parent: Root | (RootContent & Parent)) => {
    const parentSpan = spans.get(parent)
    const children = parent.children as RootContent[]
    for (const child of children) {
      const span = parsedSpan(child)
      if (span) spans.set(child, span)
    }
    for (let start = 0; start < children.length; start++) {
      if (spans.has(children[start])) continue
      let end = start
      while (end < children.length && !spans.has(children[end])) end++
      const texts = children.slice(start, end).map(literalSource)
      if (texts.every(t => t !== null)) {
        const run = texts.join('')
        const right = end < children.length ? spans.get(children[end])!.from : parentSpan?.to
        const left = start > 0 ? spans.get(children[start - 1])!.to : undefined
        const at = right !== undefined && source.slice(right - run.length, right) === run ? right - run.length
          : left !== undefined && source.slice(left, left + run.length) === run ? left
            : undefined
        if (at !== undefined) {
          let offset = at
          for (const [i, child] of children.slice(start, end).entries()) {
            const span = {from: offset, to: offset + texts[i]!.length}
            spans.set(child, span)
            if (child.type === 'link') spans.set(child.children[0], span)
            offset = span.to
          }
        }
      }
      start = end
    }
    for (const child of children) if (hasChildren(child)) visit(child)
  }
  const rootSpan = parsedSpan(tree)
  if (rootSpan) spans.set(tree, rootSpan)
  visit(tree)
  return spans
}

/** A text node whose value is exactly its source, so a source offset inside it
 *  is also an offset into its value. */
const isAddressableText = (node: RootContent, span: Span, source: string): boolean =>
  node.type === 'text' && node.value === source.slice(span.from, span.to)

/** Every leaf a range must not cut: those whose inside can't be addressed. */
const opaqueLeaves = (tree: Root, spans: WeakMap<object, Span>, source: string): Span[] => {
  const found: Span[] = []
  const walk = (node: RootContent) => {
    if (hasChildren(node)) {
      for (const child of node.children) walk(child)
      return
    }
    const span = spans.get(node)
    if (span && !isAddressableText(node, span, source)) found.push(span)
  }
  for (const child of tree.children) walk(child)
  return found
}

const drawable = (source: string, opaque: readonly Span[]) => ({from, to}: HighlightRange): boolean => {
  if (!(from >= 0 && from < to && to <= source.length)) return false
  const widened = widenToReferenceSpans(source, from, to)
  if (widened.from !== from || widened.to !== to) return false
  return opaque.every(leaf => leaf.to <= from || leaf.from >= to || (leaf.from >= from && leaf.to <= to))
}

const pointsOf = (source: string) => {
  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1)
  return (offset: number): Point => {
    let line = lineStarts.length - 1
    while (lineStarts[line] > offset) line--
    return {line: line + 1, column: offset - lineStarts[line] + 1, offset}
  }
}

const markNode = (moved: boolean, children: RootContent[]): RootContent => ({
  type: ANNOTATION_MARK_NODE,
  children,
  data: {
    hName: 'mark',
    hProperties: {className: [HIGHLIGHT_CLASS, ...MARK_CLASSES, ...(moved ? [MOVED_HIGHLIGHT_CLASS, 'border-dashed'] : [])]},
  },
} as unknown as RootContent)

type Piece = {node: RootContent; mark: (Segment & {moved: boolean}) | null}

export interface AnnotationMarksOptions {
  /** The content the ranges were resolved against. A renderer that transforms
   *  the content first gets no marks, since the ranges would not line up. */
  content: string
  ranges: readonly HighlightRange[]
}

export const remarkAnnotationMarks: Plugin<[AnnotationMarksOptions], Root> = ({content, ranges}) => (tree, file) => {
  const source = String(file.value ?? '')
  if (source !== content || ranges.length === 0) return
  const spans = spansOf(tree, source)
  const segments = segmentsOf(ranges.filter(drawable(source, opaqueLeaves(tree, spans, source))))
  if (segments.length === 0) return
  const pointAt = pointsOf(source)
  const position = (from: number, to: number): Position => ({start: pointAt(from), end: pointAt(to)})

  /** Split at every segment boundary inside `span`. A piece keeps an exact
   *  position only if the node had one from the parser. */
  const splitText = (node: RootContent & {value: string}, span: Span): Piece[] => {
    const cuts = [span.from, ...segments.flatMap(s => [s.from, s.to]).filter(c => c > span.from && c < span.to), span.to]
    const pieces: Piece[] = []
    for (let i = 0; i + 1 < cuts.length; i++) {
      const piece = {from: cuts[i], to: cuts[i + 1]}
      const text = {
        type: 'text',
        value: node.value.slice(piece.from - span.from, piece.to - span.from),
        ...(node.position ? {position: position(piece.from, piece.to)} : {}),
      } as RootContent
      const coverage = coverageOf(segments, piece)
      pieces.push({node: text, mark: coverage.kind === 'whole' ? {...piece, moved: coverage.moved} : null})
    }
    return pieces
  }

  const piecesOf = (node: RootContent, phrasing: boolean): Piece[] => {
    const span = spans.get(node)
    if (!span) return [{node, mark: null}]
    const coverage = coverageOf(segments, span)
    if (coverage.kind === 'none') return [{node, mark: null}]
    if (coverage.kind === 'whole' && phrasing) return [{node, mark: {...span, moved: coverage.moved}}]
    if (hasChildren(node)) {
      transform(node)
      return [{node, mark: null}]
    }
    // Partly covered leaves are addressable text: `drawable` refused ranges
    // that cut any other.
    return phrasing && node.type === 'text' ? splitText(node, span) : [{node, mark: null}]
  }

  /** Rebuild `parent.children`, wrapping each run of marked pieces of one
   *  style in one mark, when the markup between them is covered too. */
  const transform = (parent: Root | (RootContent & Parent)) => {
    const phrasing = PHRASING_PARENTS.has(parent.type)
    const out: RootContent[] = []
    let run: {mark: Segment; nodes: RootContent[]} | null = null
    const close = () => {
      if (run) out.push(markNode(run.mark.moved, run.nodes))
      run = null
    }
    for (const piece of (parent.children as RootContent[]).flatMap(child => piecesOf(child, phrasing))) {
      const current: {mark: Segment; nodes: RootContent[]} | null = run
      if (!piece.mark) {
        close()
        out.push(piece.node)
      } else if (current && current.mark.moved === piece.mark.moved &&
        coverageOf(segments, {from: current.mark.to, to: piece.mark.from}).kind === 'whole') {
        current.nodes.push(piece.node)
        current.mark.to = piece.mark.to
      } else {
        close()
        run = {mark: {...piece.mark}, nodes: [piece.node]}
      }
    }
    close()
    parent.children = out as Parent['children']
  }

  transform(tree)
}

/** Set on the content renderer's block context by the comment pill, which
 *  already reads the block's thread summaries. Embeds inside the content
 *  inherit it, hence the block id. */
export const THREAD_HIGHLIGHTS_KEY = 'annotations.threadHighlights'

export interface ThreadHighlightsFeed {
  blockId: string
  threads: readonly ThreadSummary[]
}

/** Ordered before the reference plugins (registered with a lower
 *  precedence), which must see whole spans. Ranges resolve against the
 *  snapshot being rendered, so they cannot lag it. */
export const threadMarksMarkdownExtension: MarkdownExtension = ({block, blockContext, data}) => {
  const feed = blockContext[THREAD_HIGHLIGHTS_KEY] as ThreadHighlightsFeed | undefined
  if (!feed || feed.blockId !== block.id || blockContext.isNestedSurface) return null
  const ranges = highlightRanges(data.content, feed.threads)
  return ranges.length === 0 ? null : {remarkPlugins: [[remarkAnnotationMarks, {content: data.content, ranges}]]}
}
