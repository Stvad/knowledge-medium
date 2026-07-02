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
import { Download, FileWarning, ImageOff, Loader2 } from 'lucide-react'
import { MarkdownImage } from '@/markdown/MarkdownImage.js'
import { downloadBlob } from '@/utils/downloadBlob.js'
import { GENERIC_MIME, isImageMime } from './mediaBlock.js'
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

/** LAZY fallback viewer for any non-image (or as-yet-unhandled) mime: a download button
 *  rendered from METADATA — it resolves NO bytes until clicked. On click it fetches the
 *  verified bytes and hands them to {@link downloadBlob}, which saves them under the
 *  original filename via a transient, immediately-revoked anchor.
 *
 *  Security: the download bytes are wrapped as `application/octet-stream`, NOT the
 *  block's `media:mime`. `media:mime` is attacker-influenceable metadata; a persistent
 *  `<a href="blob:…" download>` typed `text/html` is a same-origin XSS vector when opened
 *  in a new tab (the `download` hint is bypassed, and unreliable on iOS). A neutral
 *  content-type + a non-navigable transient anchor closes that off. A failed resolve is
 *  fail-closed (no bytes served) and the button reverts to a retryable error state. */
const FileViewer = ({ resolveBytes, mime, filename, size }: MediaViewerProps) => {
  const [status, setStatus] = useState<'idle' | 'resolving' | 'error'>('idle')
  const label = filename || mime || 'Attachment'

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

/** The image mime-family viewer — the attachments plugin's contribution to
 *  {@link mediaViewersFacet}. */
export const imageMediaViewer: MediaViewerContribution = {
  id: 'image',
  match: isImageMime,
  Component: ImageViewer,
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
