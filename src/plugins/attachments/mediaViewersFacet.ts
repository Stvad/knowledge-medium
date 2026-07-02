/**
 * The media-viewer extension point (design §11).
 *
 * A `media` block renders through a viewer chosen by its `media:mime`. Rather than
 * hard-code the branch, viewers are FACET CONTRIBUTIONS — one per mime family (image,
 * and later PDF / audio / video). A plugin adds a viewer by contributing to
 * {@link mediaViewersFacet}; {@link MediaBlockRenderer} reads the facet and dispatches,
 * never special-casing a mime. First registered `match` (precedence-ordered) wins, and a
 * built-in download fallback ({@link FILE_VIEWER_FALLBACK}) catches anything unclaimed.
 */

import type { ComponentType } from 'react'
import { defineFacet, dedupById } from '@/facets/facet.js'
import type { AssetResolveResult } from './resolver.js'
import type { AssetUrlState, ReportDecodeFailure } from './useAssetObjectUrl.js'

/** What every viewer receives. An EAGER viewer reads `state`/`reportDecodeFailure`; a
 *  LAZY one reads `resolveBytes` — each ignores the props it doesn't use, so the
 *  renderer stays a pure dispatch and never special-cases a mime. */
export interface MediaViewerProps {
  /** EAGER path: the resolve of the block's bytes to a verified object URL (§7.3).
   *  `ready` ⇒ the url wraps hash-verified bytes; `error` ⇒ fail-closed placeholder.
   *  For a LAZY viewer this is left `loading` (the renderer skips the eager resolve). */
  readonly state: AssetUrlState
  /** EAGER path: report that the verified bytes at `state.url` couldn't be DECODED (the
   *  <img> onError) — frees the Blob + goes terminal. Ignored by lazy viewers. */
  readonly reportDecodeFailure: ReportDecodeFailure
  /** LAZY path: fetch the block's VERIFIED bytes on demand (fail-closed — discards
   *  unverified bytes, §5.1). Resolves the same content as the eager path, on click. */
  readonly resolveBytes: () => Promise<AssetResolveResult>
  readonly mime: string
  readonly filename: string | undefined
  /** Plaintext byte length (`media:size`); `0` = unknown, then the size is omitted. */
  readonly size: number
}

/** One mime-family viewer. `match` is tried in precedence order (first hit wins), so a
 *  specific viewer (e.g. `application/pdf`) can sit ABOVE a broader one via precedence. */
export interface MediaViewerContribution {
  /** Stable id — the dedup key (a later same-id contribution replaces the earlier,
   *  the §6 registry convention) and a diagnostics label. */
  readonly id: string
  /** Does this viewer handle `mime`? */
  readonly match: (mime: string) => boolean
  readonly Component: ComponentType<MediaViewerProps>
  /** Render the EAGERLY-resolved object URL (inline image/PDF/audio), vs resolve LAZILY
   *  on demand (the download fallback). The renderer gates the eager resolve on this. */
  readonly eager: boolean
}

export const isMediaViewerContribution = (value: unknown): value is MediaViewerContribution => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as MediaViewerContribution
  return (
    typeof v.id === 'string' &&
    typeof v.match === 'function' &&
    typeof v.Component === 'function' &&
    typeof v.eager === 'boolean'
  )
}

export const MEDIA_VIEWERS_FACET_ID = 'attachments.media-viewers'

/** The media-viewer registry facet. Contributions fold into a precedence-ordered list
 *  (dedup by id, last-wins per §6); {@link pickMediaViewer} finds the first match. */
export const mediaViewersFacet = defineFacet<MediaViewerContribution, readonly MediaViewerContribution[]>({
  id: MEDIA_VIEWERS_FACET_ID,
  combine: dedupById(MEDIA_VIEWERS_FACET_ID),
  validate: isMediaViewerContribution,
})
