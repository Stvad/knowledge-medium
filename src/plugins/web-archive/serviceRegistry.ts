/**
 * Resolving `webarchive:serviceId` to a live `ArchiveService`.
 *
 * Read straight off `repo.facetRuntime` (the same pattern
 * `surfaceProcessorRejection` uses) rather than through a module-global
 * mirror, so a runtime swap — someone contributing a different archive
 * backend, or toggling this plugin — is reflected on the next read with no
 * sync effect to get wrong.
 */

import type { Repo } from '@/data/repo'
import { archiveServicesFacet, type ArchiveService } from './service.ts'

export const readArchiveServices = (
  repo: Repo,
): ReadonlyMap<string, ArchiveService> =>
  repo.facetRuntime?.read(archiveServicesFacet) ?? new Map()

/**
 * The service the user selected, or `undefined`.
 *
 * Deliberately NOT "fall back to any registered service": the selected id is
 * who the user agreed to publish their reading to. Silently substituting a
 * different archive because the configured one went missing would hand their
 * URLs to a third party they never picked.
 */
export const resolveArchiveService = (
  repo: Repo,
  serviceId: string,
): ArchiveService | undefined => readArchiveServices(repo).get(serviceId)
