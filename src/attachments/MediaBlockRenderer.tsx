/**
 * The `media`-block renderer (design §11). Mirrors the video-player plugin's
 * wiring: a {@link BlockRenderer} with `canRender = block.hasType('media')` and a
 * priority above the default, branching on the block's `media:mime`.
 *
 * Image branch: resolve the bytes in-thread (§7.3), wrap them as an object URL
 * (useAssetObjectUrl), and feed the existing {@link MarkdownImage} lightbox. A
 * fail-closed resolve (the resolver discarded unverified bytes, §5.1) renders the
 * broken-asset placeholder — NEVER a raw/unverified source. Non-image MIMEs get a
 * file chip for now (full file/PDF/AV rendering is vNext, §15).
 */

import { FileText, ImageOff, Loader2 } from 'lucide-react'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { usePropertyValue } from '@/hooks/block.js'
import { MarkdownImage } from '@/markdown/MarkdownImage.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { getAssetResolver } from './assetResolver.js'
import { isImageMime, mediaFilenameProp, mediaHashProp, mediaMimeProp } from './mediaBlock.js'
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

export const MediaContentRenderer = ({ block }: BlockRendererProps) => {
  const [hash] = usePropertyValue(block, mediaHashProp)
  const [mime] = usePropertyValue(block, mediaMimeProp)
  const [filename] = usePropertyValue(block, mediaFilenameProp)
  // The asset block lives in the active workspace's assets container (§11), so
  // its bytes are scoped to the active workspace; '' fails closed (deferred).
  const workspaceId = block.repo.activeWorkspaceId ?? ''
  const state = useAssetObjectUrl({ workspaceId, contentHash: hash, mime }, getAssetResolver())

  // Non-image: a file chip (full non-image rendering is vNext, §15).
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

  if (state.status === 'ready') {
    return <MarkdownImage src={state.url} alt={filename ?? ''} className="max-w-full rounded" />
  }
  if (state.status === 'loading') {
    return <Placeholder testid="media-loading" label="Loading image…" icon={<Loader2 className="h-4 w-4" />} spin />
  }
  // Fail-closed (deferred / hash-mismatch / decode / fetch / no-key / error):
  // the broken-asset placeholder — unverified bytes are never rendered (§5.1).
  return <Placeholder testid="media-broken" label="Image unavailable" icon={<ImageOff className="h-4 w-4" />} />
}

export const MediaBlockRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <DefaultBlockRenderer {...props} ContentRenderer={MediaContentRenderer} />
)

MediaBlockRenderer.canRender = ({ block }: BlockRendererProps) => block.hasType('media')
MediaBlockRenderer.priority = () => 5
