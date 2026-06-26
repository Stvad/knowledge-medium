/**
 * The `media`-block renderer (design §11). Mirrors the video-player plugin's
 * wiring: a {@link BlockRenderer} that renders blocks carrying the `media` type
 * (gated on a loaded snapshot, see canRender) at a priority above the default,
 * branching on the block's `media:mime`.
 *
 * Image branch: resolve the bytes in-thread (§7.3), wrap them as an object URL
 * (useAssetObjectUrl), and feed the existing {@link MarkdownImage} lightbox. A
 * fail-closed resolve (the resolver discarded unverified bytes, §5.1) renders the
 * broken-asset placeholder — NEVER a raw/unverified source. Bytes that verify but
 * the browser can't DECODE as an image (an untrusted `media:mime` on non-image
 * bytes, or a corrupt-but-hash-matching image) fall to the SAME placeholder via the
 * <img> onError, not the browser's broken-image glyph. Non-image MIMEs get a file
 * chip for now (full file/PDF/AV rendering is vNext, §15) and do NOT resolve bytes —
 * only the image branch fetches/decrypts.
 */

import { FileText, ImageOff, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { usePropertyValue, useWorkspaceId } from '@/hooks/block.js'
import { MarkdownImage } from '@/markdown/MarkdownImage.js'
import type { Block } from '@/data/block.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { getAssetResolver } from './assetResolver.js'
import { MEDIA_TYPE, isImageMime, mediaFilenameProp, mediaHashProp, mediaMimeProp } from './mediaBlock.js'
import { useAssetObjectUrl } from './useAssetObjectUrl.js'

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

/** Image branch — the ONLY path that resolves/decrypts bytes (§7.3). Split into
 *  its own component so a non-image block never triggers a resolve or an object
 *  URL it wouldn't use. */
const MediaImage = ({ block, hash, mime, filename }: {
  block: Block
  hash: string
  mime: string
  filename: string | undefined
}) => {
  // The asset block's OWN workspace (reactive) — bytes are workspace-scoped (§10),
  // so a foreign-workspace embed must resolve against the block's workspace, not
  // the UI's active one. '' (while loading / missing) fails closed (deferred).
  const workspaceId = useWorkspaceId(block, '')
  const state = useAssetObjectUrl({ workspaceId, contentHash: hash, mime }, getAssetResolver())
  // The verified bytes that the <img> failed to DECODE (keyed by URL so a later
  // re-resolve to a fresh, decodable object URL clears the error on its own).
  const [decodeErrorUrl, setDecodeErrorUrl] = useState<string | null>(null)

  if (state.status === 'ready' && state.url !== decodeErrorUrl) {
    return (
      <MarkdownImage
        src={state.url}
        alt={filename || 'Attachment image'}
        className="max-w-full rounded"
        onError={() => setDecodeErrorUrl(state.url)}
      />
    )
  }
  if (state.status === 'loading') {
    return <Placeholder testid="media-loading" label="Loading image…" icon={<Loader2 className="h-4 w-4" />} spin />
  }
  // Fail-closed (deferred / hash-mismatch / decode / fetch / no-key / error) OR
  // verified bytes the <img> couldn't decode (onError above): the broken-asset
  // placeholder — never unverified bytes (§5.1) and never the browser's glyph.
  return <Placeholder testid="media-broken" label="Image unavailable" icon={<ImageOff className="h-4 w-4" />} />
}

export const MediaContentRenderer = ({ block }: BlockRendererProps) => {
  const [hash] = usePropertyValue(block, mediaHashProp)
  const [mime] = usePropertyValue(block, mediaMimeProp)
  const [filename] = usePropertyValue(block, mediaFilenameProp)

  // Non-image: a file chip (full non-image rendering is vNext, §15). No resolve.
  if (!isImageMime(mime)) {
    return (
      <div
        data-testid="media-file"
        className="flex items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm"
      >
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{filename || mime || 'Attachment'}</span>
      </div>
    )
  }

  return <MediaImage block={block} hash={hash} mime={mime} filename={filename} />
}

export const MediaBlockRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <DefaultBlockRenderer {...props} ContentRenderer={MediaContentRenderer} />
)

// Gate on a LOADED snapshot, read THROW-FREE — exactly as the other peek()-based
// renderers do (PropertySchema / BlockType / TypesPage). `useRenderer` runs every
// renderer's canRender for every block during its loading window, ABOVE the
// BlockComponent ErrorBoundary, so canRender must never throw: `block.hasType()`
// throws on a not-yet-loaded / missing row, and even `getBlockTypes` throws a
// CodecError on a malformed `types` value (a non-array, or a non-string element)
// that the cache boundary doesn't validate. Reading `properties.types` raw +
// `Array.isArray` is total: undefined / wrong-shape → false, never a throw.
MediaBlockRenderer.canRender = ({ block }: BlockRendererProps) => {
  const types = block.peek()?.properties.types
  return Array.isArray(types) && types.includes(MEDIA_TYPE)
}
MediaBlockRenderer.priority = () => 5
