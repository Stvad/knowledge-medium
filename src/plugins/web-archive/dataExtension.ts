/**
 * UI-free half of the web-archive plugin: the record type, the prefs
 * container, the archive-service registry, and the processor that notices
 * links. Registered in `staticDataExtensions` so the types resolve during
 * repo bootstrap, before React mounts.
 */

import {
  definitionSeedsFacet,
  postCommitProcessorsFacet,
  typeSeedsFacet,
} from '@/data/facets.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import {
  archiveAttemptsProp,
  archiveErrorProp,
  archiveLastAttemptAtProp,
  archiveServiceProp,
  archiveSnapshotType,
  archiveSourceUrlProp,
  archiveStatusProp,
  archiveSubmittedAtProp,
  archiveUrlProp,
} from './schema.ts'
import {
  archiveDailyLimitProp,
  archiveDenylistProp,
  archiveEnabledProp,
  archiveHourlyLimitProp,
  archiveNotifyThresholdProp,
  archiveServiceIdProp,
  webArchivePrefsType,
} from './prefs.ts'
import { archiveServicesFacet, waybackArchiveService } from './service.ts'
import { webArchivePostCommitProcessors } from './processor.ts'

const SOURCE = 'web-archive'

const snapshotSeeds = [
  archiveSourceUrlProp,
  archiveUrlProp,
  archiveStatusProp,
  archiveServiceProp,
  archiveSubmittedAtProp,
  archiveLastAttemptAtProp,
  archiveAttemptsProp,
  archiveErrorProp,
]

const prefsSeeds = [
  archiveEnabledProp,
  archiveDenylistProp,
  archiveHourlyLimitProp,
  archiveDailyLimitProp,
  archiveNotifyThresholdProp,
  archiveServiceIdProp,
]

export const webArchiveDataExtension: AppExtension = [
  ...snapshotSeeds.map(prop => definitionSeedsFacet.of(prop, {source: SOURCE})),
  ...prefsSeeds.map(prop => definitionSeedsFacet.of(prop, {source: SOURCE})),
  typeSeedsFacet.of(archiveSnapshotType, {source: SOURCE}),
  ...pluginPrefsExtension(webArchivePrefsType, SOURCE),
  archiveServicesFacet.of(waybackArchiveService, {source: SOURCE}),
  ...webArchivePostCommitProcessors.map(processor =>
    postCommitProcessorsFacet.of(processor, {source: SOURCE}),
  ),
]
