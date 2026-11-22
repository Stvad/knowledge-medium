/**
 * What an `html-document` block runs in. A block's source is written by any
 * workspace member and renders in every member's client, so what crosses this
 * boundary is the protocol below and nothing else: out of the document, a clamped
 * height and the reader's selection, both read as untrusted; into it, where to
 * highlight, and only while its scripts are held, since a running document could
 * read that. `test/boundary.browser.test.ts` pins what holds and, under "what a
 * document can still do", what doesn't. The second list is why scripts don't
 * always run: see `useDocumentScripts.ts`.
 *
 * Two nested frames, both `sandbox="allow-scripts"`:
 *
 * - The OUTER frame carries the policy and nothing else. A document can always
 *   navigate its own frame, and nothing in the document's own policy stops that;
 *   only `frame-src` on the document that EMBEDS the frame does. Without
 *   this frame, `location.href = url` swaps the box for any remote page, and
 *   every other network rule here stops mattering. The app can't be that
 *   embedder without a global policy that would have to list every site it
 *   embeds.
 * - The INNER frame runs the source.
 *
 * Either frame's `sandbox` attribute alone holds the boundary, because flags
 * inherit and a document under them gets a fresh opaque origin; each is defence
 * in depth for the other. `allow-same-origin` on them is what would break it: the
 * source would then share an origin with the app.
 *
 * A srcdoc document inherits its embedder's policy, so the inner document is
 * bound before any of its markup is parsed; the source cannot come first.
 * {@link escapeAttribute} is what keeps the source out of the outer document:
 * source that reached it would run with nothing above it to stop a navigation.
 */

import {bytesToHex} from '@/sync/crypto/hex.js'

export const FRAME_SANDBOX = 'allow-scripts'

/** `run` lets the source's scripts run. `hold` lets only {@link FRAME_SCRIPT}
 *  run, so a document still renders and sizes itself but no author code executes:
 *  no inline script, event handler, `javascript:` link or child frame's script. */
export type FrameScripts = 'run' | 'hold'

/** With a `reporterNonce`, only the script carrying it runs; with `null`, all inline
 *  script does. By nonce rather than the reporter's hash: a hash also allows an
 *  external script whose `integrity` names it, and that hash is public, so a held
 *  document could send requests. Forms and popups are the sandbox's to refuse, not
 *  this policy's. */
export const framePolicy = (reporterNonce: string | null): string => [
  // Also the `frame-src` the outer frame exists to apply.
  "default-src 'none'",
  reporterNonce === null ? "script-src 'unsafe-inline'" : `script-src 'nonce-${reporterNonce}'`,
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
].join('; ')

export const MIN_FRAME_HEIGHT = 24
/** Past this a document scrolls inside its box. */
export const MAX_FRAME_HEIGHT = 4000

export const HEIGHT_MESSAGE_TYPE = 'km:html-document:height'
/** The document has parsed, so its text is there to highlight. */
export const READY_MESSAGE_TYPE = 'km:html-document:ready'
export const SELECTION_MESSAGE_TYPE = 'km:html-document:selection'
export const MARKS_MESSAGE_TYPE = 'km:html-document:marks'
export const CLEAR_SELECTION_MESSAGE_TYPE = 'km:html-document:clear-selection'

/** A digest of a document's text: its body's text nodes' values, in order.
 *  Equal digests mean the frame holds exactly the text nodes the source
 *  parses to, so a node's place among them names the same node on both
 *  sides. Neither scripts being held nor the source alone guarantee that: an
 *  edit in the document, or markup the browser builds into other nodes than
 *  the parser this app uses does, changes it. {@link FRAME_SCRIPT} embeds
 *  this function's own source, so it names nothing outside itself. */
export const textDigest = (values: readonly string[]): string => {
  let hash = 0x811c9dc5
  for (const value of values) {
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193)
    // Past any code unit, so it can't be mistaken for one.
    hash = Math.imul(hash ^ 0x10000, 0x01000193)
  }
  return `${values.length}:${(hash >>> 0).toString(36)}`
}

/** A point in the document's text: an offset into the body text node whose
 *  text is `text`, the `occurrence`th of the `count` such nodes in document
 *  order. */
export interface FramePoint {
  text: string
  occurrence: number
  count: number
  offset: number
}

/** The reader's selection, its ends moved into text, where it sits in the
 *  frame's viewport, and the {@link textDigest} of the frame's text as it was
 *  selected. */
export interface FrameSelection {
  start: FramePoint
  end: FramePoint
  rect: {top: number; left: number; bottom: number; right: number}
  digest: string
}

const MARK_KINDS = ['comment', 'comment-moved', 'suggestion', 'suggestion-moved'] as const
export type MarkKind = typeof MARK_KINDS[number]

/** A stretch of the document's text to highlight, each end the `node`th text
 *  node of the body and an offset into it. */
export interface FrameMark {
  start: {node: number; offset: number}
  end: {node: number; offset: number}
  kind: MarkKind
}

/** Marks and the {@link textDigest} of the text they were placed in. The
 *  document draws them only while its own text has that digest, and draws
 *  none otherwise; an empty list clears them. */
export interface FrameMarks {
  digest: string
  marks: readonly FrameMark[]
}

export const NO_MARKS: FrameMarks = Object.freeze({digest: '', marks: Object.freeze([])})

/** The highlights' look: the comments plugin's colours, which a frame can't
 *  take from the app's stylesheet. Painted through the CSS Custom Highlight
 *  API, which leaves the document's DOM alone. */
const MARK_CSS = [
  ['comment', 'rgb(250 204 21 / .3)', 'rgb(202 138 4 / .75)'],
  ['suggestion', 'rgb(56 189 248 / .25)', 'rgb(2 132 199 / .75)'],
].map(([kind, fill, line]) =>
  `::highlight(km-${kind}){background-color:${fill};text-decoration:underline 2px ${line}}` +
  `::highlight(km-${kind}-moved){background-color:${fill};text-decoration:underline dashed 2px ${line}}`,
).join('')

/** The app's script in the document: reports its height and the reader's
 *  selection, and draws the highlights it is sent. It runs in the inner
 *  document, so the source can replace or spoof it. That is fine: the app
 *  reads whatever arrives as untrusted ({@link readFrameReport}) and sends
 *  marks only to a held document, in which nothing else runs.
 *
 *  It runs before any of the source is parsed, so what it reads off
 *  `Document.prototype` there is the real thing; read later off `document`,
 *  a named element (`<form name="body">`) could stand in for it. A boundary
 *  point between nodes moves into text: a start forward, an end back. */
export const FRAME_SCRIPT = `(function () {
  var app = parent.parent
  var post = function (message) { app.postMessage(message, '*') }
  var proto = Document.prototype
  var getter = function (name) { return Object.getOwnPropertyDescriptor(proto, name).get }
  var bodyOf = getter('body')
  var rootOf = getter('documentElement')
  var getSelection = proto.getSelection
  var createTreeWalker = proto.createTreeWalker
  var createRange = proto.createRange
  var body = function () { return bodyOf.call(document) }

  var last = -1
  var report = function () {
    var root = body()
    var height = Math.max(
      rootOf.call(document).getBoundingClientRect().height,
      root ? root.scrollHeight : 0
    )
    if (height === last) return
    last = height
    post({type: ${JSON.stringify(HEIGHT_MESSAGE_TYPE)}, height: height})
  }
  var observer = new ResizeObserver(report)
  observer.observe(rootOf.call(document))

  var texts = function () {
    var list = []
    var root = body()
    if (!root) return list
    var walker = createTreeWalker.call(document, root, NodeFilter.SHOW_TEXT)
    for (var node = walker.nextNode(); node; node = walker.nextNode()) list.push(node)
    return list
  }
  var digest = ${textDigest.toString()}
  var digestOf = function (list) { return digest(list.map(function (node) { return node.data })) }
  var pointAt = function (list, at, offset) {
    var text = list[at].data
    var occurrence = 0
    var count = 0
    for (var i = 0; i < list.length; i++) {
      if (list[i].data !== text) continue
      if (i < at) occurrence++
      count++
    }
    return {text: text, occurrence: occurrence, count: count, offset: offset}
  }
  var pointIn = function (list, container, offset, forward) {
    if (container.nodeType === Node.TEXT_NODE) {
      var at = list.indexOf(container)
      return at < 0 ? null : pointAt(list, at, offset)
    }
    var probe = createRange.call(document)
    probe.setStart(container, offset)
    var i
    if (forward) {
      for (i = 0; i < list.length; i++) {
        if (probe.comparePoint(list[i], 0) >= 0) return pointAt(list, i, 0)
      }
    } else {
      for (i = list.length - 1; i >= 0; i--) {
        if (probe.comparePoint(list[i], list[i].length) <= 0) return pointAt(list, i, list[i].length)
      }
    }
    return null
  }
  var selected = function () {
    var selection = getSelection.call(document)
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
    var range = selection.getRangeAt(0)
    var list = texts()
    var start = pointIn(list, range.startContainer, range.startOffset, true)
    var end = pointIn(list, range.endContainer, range.endOffset, false)
    if (!start || !end) return null
    var box = range.getBoundingClientRect()
    return {
      start: start,
      end: end,
      rect: {top: box.top, left: box.left, bottom: box.bottom, right: box.right},
      digest: digestOf(list)
    }
  }
  var reported = 'null'
  var scheduled = false
  var reportSelection = function () {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(function () {
      scheduled = false
      var selection = selected()
      var json = JSON.stringify(selection)
      if (json === reported) return
      reported = json
      post({type: ${JSON.stringify(SELECTION_MESSAGE_TYPE)}, selection: selection})
    })
  }
  document.addEventListener('selectionchange', reportSelection)
  addEventListener('scroll', reportSelection, true)

  var kinds = ${JSON.stringify(MARK_KINDS)}
  var draw = function (sent) {
    if (typeof Highlight !== 'function' || !window.CSS || !CSS.highlights) return
    var list = texts()
    var marks = sent.marks.length > 0 && sent.digest === digestOf(list) ? sent.marks : []
    var byKind = {}
    kinds.forEach(function (kind) { byKind[kind] = new Highlight() })
    marks.forEach(function (mark) {
      var highlight = mark && byKind[mark.kind]
      var start = highlight && mark.start && list[mark.start.node]
      var end = highlight && mark.end && list[mark.end.node]
      if (!start || !end) return
      try {
        var range = createRange.call(document)
        range.setStart(start, mark.start.offset)
        range.setEnd(end, mark.end.offset)
        highlight.add(range)
      } catch (error) {}
    })
    kinds.forEach(function (kind) {
      byKind[kind].priority = kind.indexOf('suggestion') === 0 ? 1 : 0
      if (byKind[kind].size === 0) CSS.highlights.delete('km-' + kind)
      else CSS.highlights.set('km-' + kind, byKind[kind])
    })
  }
  addEventListener('message', function (event) {
    var data = event.data
    if (event.source !== app || !data || typeof data !== 'object') return
    if (data.type === ${JSON.stringify(MARKS_MESSAGE_TYPE)} && Array.isArray(data.marks)) draw(data)
    if (data.type === ${JSON.stringify(CLEAR_SELECTION_MESSAGE_TYPE)}) {
      var selection = getSelection.call(document)
      if (selection) selection.removeAllRanges()
    }
  })

  addEventListener('DOMContentLoaded', function () {
    post({type: ${JSON.stringify(READY_MESSAGE_TYPE)}})
    var root = body()
    if (root) observer.observe(root)
    report()
  })
  addEventListener('load', report)
})()`

/** Fresh per build, so markup written ahead of time can't carry it. Only in held
 *  documents: a running one could read it and hand it to its author. */
const freshNonce = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(16)))

/** The one barrier between the source and the outer document. In a double-quoted
 *  attribute only `"` ends the value and only `&` is decoded. */
const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

const REPLACEMENT_CHARACTER = '�'

/** The source as the inner document's parser reads it. Read back out of the
 *  attribute above, it is the source with each NUL turned into U+FFFD, one
 *  code unit for one, so an offset into either is an offset into both. An
 *  unpaired surrogate engines turn into different numbers of U+FFFD, so that
 *  is left for the text digest to tell. */
export const asFramed = (source: string): string => source.replaceAll('\u0000', REPLACEMENT_CHARACTER)

/** What the inner document holds ahead of the source. The head is left open: a
 *  source that is a whole document then parses as if it had been written here,
 *  keeping its own `<title>`, `<html>` attributes and `<body>`, and a fragment
 *  closes the head by itself. `sourceMap.ts` parses the source after this same
 *  head, which is the context it parses in; builds differ only in raw text,
 *  which never changes how what follows parses. */
export const innerDocumentHead = (themeCss: string, reporterNonce: string | null): string =>
  '<!doctype html><html><head><meta charset="utf-8">' +
  `<style>${themeCss}${MARK_CSS}</style>` +
  `<script${reporterNonce === null ? '' : ` nonce="${reporterNonce}"`}>${FRAME_SCRIPT}</script>`

/** A srcdoc document takes its base URL from its embedder, and at the top of that
 *  chain is the app's URL, which holds the workspace and the open blocks. Hence the
 *  `<base>`, and in the outer document because the source could remove its own. It
 *  also gives `#anchor` links the document they mean, rather than the app's URL. */
export const buildFrameDocument = (source: string, themeCss: string, scripts: FrameScripts): string => {
  const reporterNonce = scripts === 'hold' ? freshNonce() : null
  return '<!doctype html><html><head><meta charset="utf-8"><base href="about:srcdoc">' +
  `<meta http-equiv="Content-Security-Policy" content="${framePolicy(reporterNonce)}">` +
  `<style>${themeCss}html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>` +
  '</head><body>' +
  `<iframe sandbox="${FRAME_SANDBOX}" title="HTML document" srcdoc="${escapeAttribute(innerDocumentHead(themeCss, reporterNonce) + source)}"></iframe>` +
  '</body></html>'
}

/** What a document posts, as the app reads it. */
export type FrameReport =
  | {kind: 'height'; height: number}
  | {kind: 'ready'}
  | {kind: 'selection'; selection: FrameSelection | null}

const fieldsOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : null

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0
const isFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const readPoint = (value: unknown): FramePoint | null => {
  const fields = fieldsOf(value)
  if (!fields) return null
  const {text, occurrence, count, offset} = fields
  return typeof text === 'string' && isIndex(occurrence) && isIndex(count) && isIndex(offset)
    ? {text, occurrence, count, offset}
    : null
}

const readRect = (value: unknown): FrameSelection['rect'] | null => {
  const fields = fieldsOf(value)
  if (!fields) return null
  const {top, left, bottom, right} = fields
  return isFinite(top) && isFinite(left) && isFinite(bottom) && isFinite(right) ? {top, left, bottom, right} : null
}

/** A malformed selection reads as none. */
const readSelection = (value: unknown): FrameSelection | null => {
  const fields = fieldsOf(value)
  if (!fields) return null
  const start = readPoint(fields.start)
  const end = readPoint(fields.end)
  const rect = readRect(fields.rect)
  const {digest} = fields
  return start && end && rect && typeof digest === 'string' ? {start, end, rect, digest} : null
}

/** Total over anything a frame can post; null for anything that is not a
 *  report. A height is clamped to the frame limits, rounded up so a fractional
 *  one doesn't clip the last line. */
export const readFrameReport = (data: unknown): FrameReport | null => {
  const fields = fieldsOf(data)
  switch (fields?.type) {
    case HEIGHT_MESSAGE_TYPE:
      return isFinite(fields.height)
        ? {kind: 'height', height: Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(fields.height)))}
        : null
    case READY_MESSAGE_TYPE:
      return {kind: 'ready'}
    case SELECTION_MESSAGE_TYPE:
      return {kind: 'selection', selection: readSelection(fields.selection)}
    default:
      return null
  }
}

/** The window the source runs in, which is the only one whose height reports
 *  count. A cross-origin frame's `frames` is readable, so this needs no relay
 *  script in the outer document. Reading past a cross-origin window's last child
 *  throws, and the outer has no child until it has parsed. */
export const documentWindowOf = (outerFrame: HTMLIFrameElement): Window | undefined => {
  const outer = outerFrame.contentWindow
  return outer && outer.length > 0 ? outer.frames[0] : undefined
}
