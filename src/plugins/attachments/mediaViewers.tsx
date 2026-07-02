/**
 * The media-block viewer components + the picker over the {@link mediaViewersFacet}
 * registry (design §11).
 *
 * The renderer resolves a block's bytes per-viewer and hands them here:
 *   - EAGER (image today; inline PDF/audio later): the bytes are resolved once into a
 *     verified object URL (via {@link useAssetObjectUrl}, §7.3) and the viewer renders
 *     that url. Fail-closed by construction — a `ready` url wraps ONLY hash-verified
 *     bytes (§5.1); a failed resolve is `error` → the broken placeholder, never an
 *     unverified source.
 *   - LAZY (the download fallback): the viewer resolves NOTHING on mount — it renders
 *     from metadata (filename/size/mime) and fetches the verified bytes only when the
 *     user clicks download, then triggers a transient octet-stream download (never a
 *     navigable `blob:` URL — see {@link FileViewer}). The bytes are already on local
 *     disk in the common case (the down-lane replicates every media block for offline,
 *     §8), so the click is a fast local read; staying lazy avoids retaining a decrypted
 *     object-URL Blob in memory for a download nobody opened.
 */

import { useCallback, useState } from 'react'
import { Download, FileText, FileWarning, ImageOff, Loader2 } from 'lucide-react'
import { MarkdownImage } from '@/markdown/MarkdownImage.js'
import { downloadBlob } from '@/utils/downloadBlob.js'
import { GENERIC_MIME, PDF_MIME, isImageMime, isPdfMime } from './mediaBlock.js'
import type { AssetResolveResult } from './resolver.js'
import type { MediaViewerContribution, MediaViewerProps } from './mediaViewersFacet.js'

/** A muted inline chip standing in for the real content: the loading spinner and the
 *  fail-closed broken/unavailable placeholder. `role="img"` + `aria-label` so a
 *  placeholder is announced as the asset it replaces, not read as empty. */
const Placeholder = ({
  testid,
  label,
  icon,
  spin = false,
}: {
  testid: string
  label: string
  icon: React.ReactNode
  spin?: boolean
}) => (
  <div
    data-testid={testid}
    role="img"
    aria-label={label}
    className="flex items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
  >
    <span className={spin ? 'animate-spin' : undefined}>{icon}</span>
    <span>{label}</span>
  </div>
)

/** Format a plaintext byte length for the file affordance (e.g. `1.4 MB`). Sub-KiB is
 *  shown in whole bytes; larger units keep one decimal below 10, whole above. Binary
 *  (1024) units to match how the capture-size cap / byte store think about size. */
export const formatByteSize = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? value : value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${units[unit]}`
}

/** EAGER image viewer — the object URL feeds the existing {@link MarkdownImage} lightbox.
 *  Verified bytes the browser can't decode as an image (an untrusted `media:mime` over
 *  non-image bytes, or a corrupt-but-hash-matching file) fall to the SAME broken
 *  placeholder via onError, not the browser's broken-image glyph. */
const ImageViewer = ({ state, reportDecodeFailure, filename }: MediaViewerProps) => {
  if (state.status === 'ready') {
    return (
      <MarkdownImage
        src={state.url}
        alt={filename || 'Attachment image'}
        className="max-w-full rounded"
        onError={() => reportDecodeFailure(state.url)}
      />
    )
  }
  if (state.status === 'loading') {
    return <Placeholder testid="media-loading" label="Loading image…" icon={<Loader2 className="h-4 w-4" />} spin />
  }
  return <Placeholder testid="media-broken" label="Image unavailable" icon={<ImageOff className="h-4 w-4" />} />
}

type DownloadStatus = 'idle' | 'resolving' | 'error'

/** Shared lazy-download control for the file + PDF viewers: fetch the block's VERIFIED
 *  bytes on demand and save them via {@link downloadBlob}.
 *
 *  Security: the saved bytes are wrapped as `application/octet-stream`, NOT the block's
 *  `media:mime`. `media:mime` is attacker-influenceable metadata; a persistent
 *  `<a href="blob:…" download>` typed `text/html` is a same-origin XSS vector when opened
 *  in a new tab (the `download` hint is bypassed, and unreliable on iOS). A neutral
 *  content-type saved through a non-navigable transient anchor closes that off. A failed
 *  resolve is fail-closed (no bytes served) and `status` reverts to a retryable `error`. */
const useLazyDownload = (
  resolveBytes: () => Promise<AssetResolveResult>,
  filename: string | undefined,
): { status: DownloadStatus; onDownload: () => void } => {
  const [status, setStatus] = useState<DownloadStatus>('idle')
  const onDownload = useCallback(() => {
    setStatus('resolving')
    void resolveBytes()
      .then((result) => {
        if (!result.ok) {
          setStatus('error')
          return
        }
        downloadBlob(new Blob([result.bytes], { type: GENERIC_MIME }), filename || 'attachment')
        setStatus('idle')
      })
      .catch(() => setStatus('error')) // resolve() is fail-closed, but never leave it hanging
  }, [resolveBytes, filename])
  return { status, onDownload }
}

/** LAZY fallback viewer for any non-image (or as-yet-unhandled) mime: a download button
 *  rendered from METADATA — it resolves NO bytes until clicked, then saves the verified
 *  bytes under the original filename via {@link useLazyDownload} (transient octet-stream
 *  anchor — never a navigable `blob:` typed with the attacker-influenceable `media:mime`). */
const FileViewer = ({ resolveBytes, mime, filename, size }: MediaViewerProps) => {
  const { status, onDownload } = useLazyDownload(resolveBytes, filename)
  const label = filename || mime || 'Attachment'

  return (
    <button
      type="button"
      data-testid="media-file"
      onClick={onDownload}
      disabled={status === 'resolving'}
      aria-label={status === 'error' ? `${label} — download failed, click to retry` : `Download ${label}`}
      className="inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-70"
    >
      {status === 'resolving' ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : status === 'error' ? (
        <FileWarning className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{label}</span>
      {size > 0 && <span className="shrink-0 text-muted-foreground">{formatByteSize(size)}</span>}
      {status === 'error' && <span className="shrink-0 text-muted-foreground">· unavailable</span>}
    </button>
  )
}

/** EAGER inline PDF viewer: a bounded-height `<object>` of the verified object URL,
 *  plus an always-visible download affordance (an inline preview isn't a substitute for
 *  the file — and some browsers, e.g. iOS Safari, can't render a PDF in an `<object>` at
 *  all; the `<object>` fallback content then points at the download).
 *
 *  Security: the object URL wraps the bytes as the block's `media:mime`, but this viewer
 *  only matches `application/pdf` ({@link isPdfMime}), so the Blob's type is ALWAYS
 *  `application/pdf` — never attacker-arbitrary. A `blob:` typed `application/pdf` is
 *  handed to the browser's PDF viewer (a known non-`text/*` type isn't HTML-sniffed), so
 *  even hash-verified-but-non-PDF bytes render as a broken PDF, never as executable HTML.
 *  The download stays neutral octet-stream (see {@link useLazyDownload}). A failed resolve
 *  is fail-closed → the broken-asset placeholder, never an unverified source (§5.1). */
const PdfViewer = ({ state, resolveBytes, filename }: MediaViewerProps) => {
  const { status, onDownload } = useLazyDownload(resolveBytes, filename)
  const label = filename || 'PDF'

  if (state.status === 'loading') {
    return <Placeholder testid="media-loading" label="Loading PDF…" icon={<Loader2 className="h-4 w-4" />} spin />
  }
  // Fail-closed (deferred / hash-mismatch / decode / fetch / no-key / error): the
  // broken-asset placeholder — never the object-URL of an unverified source (§5.1).
  if (state.status !== 'ready') {
    return <Placeholder testid="media-broken" label="PDF unavailable" icon={<FileWarning className="h-4 w-4" />} />
  }

  return (
    <div data-testid="media-pdf" className="overflow-hidden rounded border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-sm">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
        <button
          type="button"
          data-testid="media-pdf-download"
          onClick={onDownload}
          disabled={status === 'resolving'}
          aria-label={status === 'error' ? `Download ${label} — failed, click to retry` : `Download ${label}`}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-70"
        >
          {status === 'resolving' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : status === 'error' ? (
            <FileWarning className="h-3.5 w-3.5" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          <span>{status === 'error' ? 'Retry' : 'Download'}</span>
        </button>
      </div>
      {/* Bounded so a tall PDF doesn't take over the note; the native viewer scrolls
          within. type is pinned to application/pdf — the Blob is that type by construction. */}
      <object data={state.url} type={PDF_MIME} aria-label={label} className="block h-[60vh] max-h-[800px] w-full bg-muted/20">
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          This browser can’t preview PDFs inline — use Download above.
        </div>
      </object>
    </div>
  )
}

/** The image mime-family viewer — the attachments plugin's contribution to
 *  {@link mediaViewersFacet}. */
export const imageMediaViewer: MediaViewerContribution = {
  id: 'image',
  match: isImageMime,
  Component: ImageViewer,
  eager: true,
}

/** The inline-PDF viewer contribution — an eager viewer for `application/pdf`
 *  ({@link mediaViewersFacet}). Sits alongside the image viewer; the mimes don't
 *  overlap, so registration order doesn't matter. */
export const pdfMediaViewer: MediaViewerContribution = {
  id: 'pdf',
  match: isPdfMime,
  Component: PdfViewer,
  eager: true,
}

/** The built-in floor: every attachment is at least downloadable. Returned by
 *  {@link pickMediaViewer} when no registered viewer claims the mime — NOT itself a
 *  facet contribution, so it can't be dropped and a page always has a working affordance
 *  even if the viewer facet is empty. A plugin CAN still override it with a match-all
 *  contribution (which `find` reaches first). */
export const FILE_VIEWER_FALLBACK: MediaViewerContribution = {
  id: 'file',
  match: () => true,
  Component: FileViewer,
  eager: false,
}

/** Pick the viewer for `mime` from the facet-resolved list — first match (the list is
 *  precedence-ordered), else the download fallback. Total: always returns a viewer, so
 *  the renderer never branches on mime itself. */
export const pickMediaViewer = (
  viewers: readonly MediaViewerContribution[],
  mime: string,
): MediaViewerContribution => viewers.find((viewer) => viewer.match(mime)) ?? FILE_VIEWER_FALLBACK
