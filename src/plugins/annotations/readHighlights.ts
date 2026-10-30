/**
 * Read-mode highlights: each open thread's quote, marked in the rendered
 * markdown by a remark transform that runs after every other remark plugin.
 *
 * Last, because marking first would change what those plugins see: a split
 * through a timestamp or a reference turns it into a different token, and a
 * node wrapped in a mark loses the position a page embed's occurrence id is
 * computed from. Running last, every token is already a node, and the rule is
 * one: plain text may be cut, anything else is marked whole or not at all.
 *
 * A quote is raw-content offsets; the tree knows only source spans. The
 * mapping is exact or the quote is not drawn:
 *
 * - a text node whose value IS its source slice is split at the range's
 *   boundaries;
 * - any other node (inline code, an image, a reference, a timestamp, text
 *   whose value differs from its source because of an escape or an entity)
 *   is opaque: marked whole when the range covers it, and a range that cuts
 *   one is not drawn;
 * - only phrasing content is wrapped; a covered paragraph or list item is
 *   marked inside.
 *
 * The plugins before this one leave the nodes they create with no position.
 * Their spans are recovered by aligning each positionless run against its
 * positioned neighbours, from the source each node stands for, and kept only
 * where the source spells it exactly; what can't be aligned is opaque.
 * Recovered spans stay in this transform: a node it does not split keeps the
 * position it had, absent or not.
 */

import type {Parent, Root, RootContent} from 'mdast'
import type {Plugin} from 'unified'
import type {MarkdownExtension} from '@/markdown/extensions.js'
import {HIGHLIGHT_CLASS, highlightRanges, MOVED_HIGHLIGHT_CLASS, type HighlightRange} from './highlights.ts'
import type {HighlightThread} from './summaries.ts'

const ANNOTATION_MARK_NODE = 'annotationMark'

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

/** Markdown's own containers whose children are phrasing content, the only
 *  place a mark can sit. */
const PHRASING_PARENTS = new Set(['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference'])

/** Markdown's own containers, which this descends into. Every other node with
 *  children was made by a plugin (a wikilink, a block ref) and is one token. */
const MARKDOWN_CONTAINERS = new Set([
  'root', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'footnoteDefinition', ...PHRASING_PARENTS,
])

type Container = Root | (RootContent & Parent)

const isContainer = (node: RootContent | Root): node is Container => MARKDOWN_CONTAINERS.has(node.type)

const parsedSpan = (node: RootContent | Root): Span | null => {
  const from = node.position?.start.offset
  const to = node.position?.end.offset
  return from === undefined || to === undefined ? null : {from, to}
}

/** Text markdown may have decoded from longer source: a backslash (an
 *  escape, or what one left), an entity, a line whose prefix was stripped.
 *  Decoding only shortens, so the decoded text can also be spelled, one or
 *  more characters early, by the source it came from (`&amp;amp;` reads
 *  `&amp;`), and aligning it there would mark the wrong text. */
const MAYBE_DECODED = /\\|&[#a-z]|\n[>\s]/i

/** The source text a positionless node stands for, where it is knowable:
 *  text is itself, an autolink literal is its one text child, and a plugin's
 *  token keeps its raw source as its `value`. Never text that may have been
 *  decoded. */
const literalSource = (node: RootContent): string | null => {
  const text = node.type === 'link' ? autolinkText(node) : (node as {value?: unknown}).value
  return typeof text === 'string' && !MAYBE_DECODED.test(text) ? text : null
}

const autolinkText = (node: RootContent & {type: 'link'}): string | null => {
  const [child] = node.children
  if (node.children.length !== 1 || child.type !== 'text') return null
  const url = node.url ?? ''
  return [child.value, `mailto:${child.value}`, `http://${child.value}`, `https://${child.value}`].includes(url)
    ? child.value
    : null
}

/** Every node's span: the parser's, or one recovered for a run of positionless
 *  siblings. The run is aligned forward from the positioned sibling before it
 *  (or the parent's start) and back from the one after it (or the parent's
 *  end), node by node, each kept only where the source spells exactly the text
 *  that node stands for. A node in the middle that neither end reaches (one
 *  whose source isn't knowable) gets the whole stretch left between them,
 *  which makes that stretch opaque. */
const spansOf = (tree: Root, source: string): WeakMap<object, Span> => {
  const spans = new WeakMap<object, Span>()
  const visit = (parent: Container) => {
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
      let from = start > 0 ? spans.get(children[start - 1])!.to : parentSpan?.from
      let to = end < children.length ? spans.get(children[end])!.from : parentSpan?.to
      let i = start
      for (; i < end && from !== undefined; i++) {
        const text = literalSource(children[i])
        if (text === null || source.slice(from, from + text.length) !== text) break
        spans.set(children[i], {from, to: from + text.length})
        from += text.length
      }
      let j = end - 1
      for (; j >= i && to !== undefined; j--) {
        const text = literalSource(children[j])
        if (text === null || source.slice(to - text.length, to) !== text) break
        spans.set(children[j], {from: to - text.length, to})
        to -= text.length
      }
      if (from !== undefined && to !== undefined && from <= to) {
        for (let k = i; k <= j; k++) spans.set(children[k], {from, to})
      }
      start = end
    }
    for (const child of children) if (isContainer(child)) visit(child)
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

/** Every node a range must not cut: anything whose inside can't be
 *  addressed. */
const opaqueSpans = (tree: Root, spans: WeakMap<object, Span>, source: string): Span[] => {
  const found: Span[] = []
  const walk = (node: RootContent) => {
    if (isContainer(node)) {
      for (const child of node.children) walk(child)
      return
    }
    const span = spans.get(node)
    if (span && !isAddressableText(node, span, source)) found.push(span)
  }
  for (const child of tree.children) walk(child)
  return found
}

const drawable = (opaque: readonly Span[]) => ({from, to}: HighlightRange): boolean =>
  opaque.every(node => node.to <= from || node.from >= to || (node.from >= from && node.to <= to))

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

/** `moved` is the piece's highlight style, or null when it is not marked. */
type Piece = {node: RootContent; moved: boolean | null}

export interface AnnotationMarksOptions {
  /** The content the ranges were resolved against. A renderer that transforms
   *  the content first gets no marks, since the ranges would not line up. */
  content: string
  ranges: readonly HighlightRange[]
}

export const remarkAnnotationMarks: Plugin<[AnnotationMarksOptions], Root> = ({content, ranges}) => (tree, file) => {
  const source = String(file.value ?? '')
  if (source !== content) return
  const spans = spansOf(tree, source)
  const segments = segmentsOf(ranges.filter(drawable(opaqueSpans(tree, spans, source))))
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
      pieces.push({node: text, moved: coverage.kind === 'whole' ? coverage.moved : null})
    }
    return pieces
  }

  const piecesOf = (node: RootContent, phrasing: boolean): Piece[] => {
    const span = spans.get(node)
    if (!span) return [{node, moved: null}]
    const coverage = coverageOf(segments, span)
    if (coverage.kind === 'none') return [{node, moved: null}]
    if (coverage.kind === 'whole' && phrasing) return [{node, moved: coverage.moved}]
    if (isContainer(node)) {
      transform(node)
      return [{node, moved: null}]
    }
    // Partly covered, so addressable text: `drawable` refused ranges that cut
    // anything else.
    return node.type === 'text' ? splitText(node, span) : [{node, moved: null}]
  }

  /** Rebuild `parent.children`, wrapping each run of adjacent marked pieces
   *  of one style in one mark, so a quote reads as one mark rather than one
   *  per node. */
  const transform = (parent: Container) => {
    const phrasing = PHRASING_PARENTS.has(parent.type)
    const out: RootContent[] = []
    let run = null as {moved: boolean; nodes: RootContent[]} | null
    for (const {node, moved} of (parent.children as RootContent[]).flatMap(child => piecesOf(child, phrasing))) {
      if (moved === null) {
        run = null
        out.push(node)
      } else if (run?.moved === moved) {
        run.nodes.push(node)
      } else {
        run = {moved, nodes: [node]}
        out.push(markNode(moved, run.nodes))
      }
    }
    parent.children = out as Parent['children']
  }

  transform(tree)
}

/** Set on the content renderer's block context by the comment pill, which
 *  already reads the block's thread summaries. Embeds inside the content
 *  inherit it, hence the block id.
 *
 *  ACCEPTED: block context is inherited, so a new feed is a new context for
 *  everything under the content, and an embed or block ref inside it
 *  remounts, an editor open in an embed included. The feed carries only what
 *  the marks read, so that happens when a range thread on the block appears,
 *  resolves or moves, not on every comment. Avoiding it entirely needs a
 *  core seam for reactive markdown input. */
export const THREAD_HIGHLIGHTS_KEY = 'annotations.threadHighlights'

export interface ThreadHighlightsFeed {
  blockId: string
  threads: readonly HighlightThread[]
}

/** Ranges resolve against the snapshot being rendered, so they cannot lag
 *  it. */
export const threadMarksMarkdownExtension: MarkdownExtension = ({block, blockContext, data}) => {
  const feed = blockContext[THREAD_HIGHLIGHTS_KEY] as ThreadHighlightsFeed | undefined
  if (!feed || feed.blockId !== block.id || blockContext.isNestedSurface) return null
  const ranges = highlightRanges(data.content, feed.threads)
  return ranges.length === 0 ? null : {remarkPlugins: [[remarkAnnotationMarks, {content: data.content, ranges}]]}
}
