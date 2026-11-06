/**
 * What an `html-document` block runs in. A block's source is written by any
 * workspace member and renders in every member's client, so nothing crosses this
 * boundary except a clamped height. `test/boundary.browser.test.ts` pins what holds
 * and, under "what a document can still do", what doesn't. The second list is why
 * scripts don't always run: see `useDocumentScripts.ts`.
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

/** `run` lets the source's scripts run. `hold` lets only {@link HEIGHT_REPORTER}
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

/** Runs in the inner document, so the source can replace or spoof it. That is
 *  fine: {@link readReportedHeight} treats whatever arrives as untrusted. */
export const HEIGHT_REPORTER = `(function () {
  var last = -1
  var report = function () {
    var body = document.body
    var height = Math.max(
      document.documentElement.getBoundingClientRect().height,
      body ? body.scrollHeight : 0
    )
    if (height === last) return
    last = height
    parent.parent.postMessage({type: ${JSON.stringify(HEIGHT_MESSAGE_TYPE)}, height: height}, '*')
  }
  var observer = new ResizeObserver(report)
  observer.observe(document.documentElement)
  addEventListener('DOMContentLoaded', function () { observer.observe(document.body); report() })
  addEventListener('load', report)
})()`

/** Fresh per build, so markup written ahead of time can't carry it. Only in held
 *  documents: a running one could read it and hand it to its author. */
const freshNonce = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(16)))

/** The one barrier between the source and the outer document. In a double-quoted
 *  attribute only `"` ends the value and only `&` is decoded. */
const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** The head is left open: a source that is a whole document then parses as if
 *  it had been written here, keeping its own `<title>`, `<html>` attributes and
 *  `<body>`, and a fragment closes the head by itself. */
const innerDocument = (source: string, themeCss: string, reporterNonce: string | null): string =>
  '<!doctype html><html><head><meta charset="utf-8">' +
  `<style>${themeCss}</style>` +
  `<script${reporterNonce === null ? '' : ` nonce="${reporterNonce}"`}>${HEIGHT_REPORTER}</script>` +
  source

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

/** Total over anything a frame can post. */
export const readReportedHeight = (data: unknown): number | null => {
  if (typeof data !== 'object' || data === null) return null
  const {type, height} = data as {type?: unknown; height?: unknown}
  if (type !== HEIGHT_MESSAGE_TYPE || typeof height !== 'number' || !Number.isFinite(height)) return null
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)))
}

/** The window the source runs in, which is the only one whose height reports
 *  count. A cross-origin frame's `frames` is readable, so this needs no relay
 *  script in the outer document. Reading past a cross-origin window's last child
 *  throws, and the outer has no child until it has parsed. */
export const documentWindowOf = (outerFrame: HTMLIFrameElement): Window | undefined => {
  const outer = outerFrame.contentWindow
  return outer && outer.length > 0 ? outer.frames[0] : undefined
}
