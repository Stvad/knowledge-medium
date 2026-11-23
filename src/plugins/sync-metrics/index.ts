import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { appEffectsFacet } from '@/extensions/core.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { collectSyncMetricsEffect } from './collect.ts'
import { syncMetricsRecordProp, syncMetricsRecordType, syncMetricsUIStateType } from './record.ts'

/** Persists real-device timings of large sync materialization drains and of the
 *  initial download, so a cold workspace load can be looked up per device. */
export const syncMetricsPlugin: AppExtension = systemToggle({
  id: 'system:sync-metrics',
  name: 'Sync metrics',
  description: 'Records how long large sync drains and the initial download take on this device.',
}).of([
  appEffectsFacet.of(collectSyncMetricsEffect, { source: 'sync-metrics' }),
  definitionSeedsFacet.of(syncMetricsRecordProp, { source: 'sync-metrics' }),
  typeSeedsFacet.of(syncMetricsRecordType, { source: 'sync-metrics' }),
  typeSeedsFacet.of(syncMetricsUIStateType, { source: 'sync-metrics' }),
])
