/**
 * The seam the conversion flow reaches the attachment cleaner's Storage through
 * ({@link AttachmentCleanerIO}). Core declares it; the attachments plugin, which
 * owns Storage access, the byte store and the media type, supplies the impl.
 * Whenever it is unavailable the flow can't prove the folder clean, so it must
 * not finish the conversion; the reason says what to fix.
 */

import type { Repo } from '@/data/repo.js'
import { defineVerbFacet } from '@/facets/verbFacet.js'
import type { AttachmentCleanerIO } from '@/sync/conversion/attachmentCleaner.js'

export interface AttachmentCleanerIOInput {
  readonly repo: Repo
  readonly workspaceId: string
}

export type AttachmentCleanerIOResult =
  | {readonly kind: 'ready'; readonly io: AttachmentCleanerIO}
  | {readonly kind: 'unavailable'; readonly reason: string}

export const attachmentCleanerIOVerb = defineVerbFacet<AttachmentCleanerIOInput, AttachmentCleanerIOResult>({
  id: 'conversion.attachment-cleaner-io',
  defaultImpl: () => ({kind: 'unavailable', reason: 'the attachments plugin is off'}),
})
