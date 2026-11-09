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

/** A point in the document's text: an offset into the body text node whose
 *  text is `text`, the `occurrence`th of the `count` such nodes in document
 *  order. Named by text, not by place among all text nodes, so text a running
 *  script adds elsewhere doesn't move it, and a node a script changed names
 *  nothing. */
export interface FramePoint {
  text: string
  occurrence: number
  count: number
  offset: number
}

/** The reader's selection, its ends moved into text, and where it sits in the
 *  frame's viewport. */
export interface FrameSelection {
  start: FramePoint
  end: FramePoint
  rect: {top: number; left: number; bottom: number; right: number}
}

export const MARK_KINDS = ['comment', 'comment-moved', 'suggestion', 'suggestion-moved'] as const
export type MarkKind = typeof MARK_KINDS[number]

/** A stretch of the document's text to highlight, each end the `node`th text
 *  node of the body and an offset into it. Sent only to a held document, whose
 *  text nodes are the ones its source parses to. */
export interface FrameMark {
  start: {node: number; offset: number}
  end: {node: number; offset: number}
  kind: MarkKind
}

/** The highlights' look: the comments plugin's colours, which a frame can't
 *  take from the app's stylesheet. Painted through the CSS Custom Highlight
 *  API, which leaves the document's DOM alone, so the text nodes the app
 *  counts stay the ones the source parses to. */
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
 *  reads whatever arrives as untrusted ({@link readReportedHeight},
 *  {@link readReportedSelection}) and sends marks only to a held document, in
 *  which nothing else runs. A boundary point between nodes moves into text:
 *  a start forward, an end back. */
export const FRAME_SCRIPT = `(function () {
  var app = parent.parent
  var post = function (message) { app.postMessage(message, '*') }
  var last = -1
  var report = function () {
    var body = document.body
    var height = Math.max(
      document.documentElement.getBoundingClientRect().height,
      body ? body.scrollHeight : 0
    )
    if (height === last) return
    last = height
    post({type: ${JSON.stringify(HEIGHT_MESSAGE_TYPE)}, height: height})
  }
  var observer = new ResizeObserver(report)
  observer.observe(document.documentElement)

  var texts = function () {
    var list = []
    if (!document.body) return list
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (var node = walker.nextNode(); node; node = walker.nextNode()) list.push(node)
    return list
  }
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
    var probe = document.createRange()
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
    var selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
    var range = selection.getRangeAt(0)
    var list = texts()
    var start = pointIn(list, range.startContainer, range.startOffset, true)
    var end = pointIn(list, range.endContainer, range.endOffset, false)
    if (!start || !end) return null
    var box = range.getBoundingClientRect()
    return {start: start, end: end, rect: {top: box.top, left: box.left, bottom: box.bottom, right: box.right}}
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
  var draw = function (marks) {
    if (typeof Highlight !== 'function' || !window.CSS || !CSS.highlights) return
    var list = texts()
    var byKind = {}
    kinds.forEach(function (kind) { byKind[kind] = new Highlight() })
    marks.forEach(function (mark) {
      var highlight = mark && byKind[mark.kind]
      var start = highlight && mark.start && list[mark.start.node]
      var end = highlight && mark.end && list[mark.end.node]
      if (!start || !end) return
      try {
        var range = document.createRange()
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
    if (data.type === ${JSON.stringify(MARKS_MESSAGE_TYPE)} && Array.isArray(data.marks)) draw(data.marks)
    if (data.type === ${JSON.stringify(CLEAR_SELECTION_MESSAGE_TYPE)}) {
      var selection = document.getSelection()
      if (selection) selection.removeAllRanges()
    }
  })

  addEventListener('DOMContentLoaded', function () {
    observer.observe(document.body)
    report()
    post({type: ${JSON.stringify(READY_MESSAGE_TYPE)}})
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

/** The source as the inner document's parser reads it. Read back out of the
 *  attribute above, it is the source with each NUL turned into U+FFFD, one
 *  character for one, so an offset into either is an offset into both. */
export const asFramed = (source: string): string => source.replaceAll('\0', '�')

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

const innerDocument = (source: string, themeCss: string, reporterNonce: string | null): string =>
  innerDocumentHead(themeCss, reporterNonce) + source

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
  `<iframe sandbox="${FRAME_SANDBOX}" title="HTML document" srcdoc="${escapeAttribute(innerDocument(source, themeCss, reporterNonce))}"></iframe>` +
  '</body></html>'
}

const typeOf = (data: unknown): unknown =>
  typeof data === 'object' && data !== null ? (data as {type?: unknown}).type : undefined

/** Total over anything a frame can post. */
export const readReportedHeight = (data: unknown): number | null => {
  if (typeOf(data) !== HEIGHT_MESSAGE_TYPE) return null
  const {height} = data as {height?: unknown}
  if (typeof height !== 'number' || !Number.isFinite(height)) return null
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)))
}

export const isReadyMessage = (data: unknown): boolean => typeOf(data) === READY_MESSAGE_TYPE

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

const readPoint = (value: unknown): FramePoint | null => {
  if (typeof value !== 'object' || value === null) return null
  const {text, occurrence, count, offset} = value as Record<string, unknown>
  return typeof text === 'string' && isIndex(occurrence) && isIndex(count) && isIndex(offset)
    ? {text, occurrence, count, offset}
    : null
}

const readRect = (value: unknown): FrameSelection['rect'] | null => {
  if (typeof value !== 'object' || value === null) return null
  const {top, left, bottom, right} = value as Record<string, unknown>
  const sides = [top, left, bottom, right]
  return sides.every(side => typeof side === 'number' && Number.isFinite(side))
    ? {top: top as number, left: left as number, bottom: bottom as number, right: right as number}
    : null
}

/** Total over anything a frame can post: undefined for anything but a
 *  selection report, null for a report of no selection (or a malformed one). */
export const readReportedSelection = (data: unknown): FrameSelection | null | undefined => {
  if (typeOf(data) !== SELECTION_MESSAGE_TYPE) return undefined
  const {selection} = data as {selection?: unknown}
  if (typeof selection !== 'object' || selection === null) return null
  const {start, end, rect} = selection as Record<string, unknown>
  const read = {start: readPoint(start), end: readPoint(end), rect: readRect(rect)}
  return read.start && read.end && read.rect ? read as FrameSelection : null
}

/** The window the source runs in, which is the only one whose height reports
 *  count. A cross-origin frame's `frames` is readable, so this needs no relay
 *  script in the outer document. Reading past a cross-origin window's last child
 *  throws, and the outer has no child until it has parsed. */
export const documentWindowOf = (outerFrame: HTMLIFrameElement): Window | undefined => {
  const outer = outerFrame.contentWindow
  return outer && outer.length > 0 ? outer.frames[0] : undefined
}
