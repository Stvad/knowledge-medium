import { attachmentCleanerIOVerb } from '@/data/attachmentCleanerIOVerb.js'
import type { AppExtension } from '@/facets/facet.js'

export const attachmentCleanerIOContribution = attachmentCleanerIOVerb.impl(
  // Loaded when asked for: the data runtime's extensions are imported by the
  // repo provider itself, which the IO's Storage and byte store depend on.
  async ({repo, workspaceId}) => (await import('./cleanerIO.js')).cleanerIOFor(repo, workspaceId),
  {source: 'attachments'},
)

/** In the data runtime as well as the plugin's: the conversion flow runs from
 *  the workspace gate, where no app runtime has been installed yet. */
export const attachmentsDataExtension: AppExtension = [attachmentCleanerIOContribution]
