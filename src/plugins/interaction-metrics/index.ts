import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { interactionMetricsEffectContribution } from './schedule.ts'
import { interactionMetricsUIStateType, interactionRecordProp } from './record.ts'

/** Records a durable per-session snapshot of the data layer's own counters
 *  (query latencies, invalidation fan-out, handle inventory) so interaction
 *  performance is trendable across builds instead of only observable in a live
 *  tab. The reading/alerting half is `@/plugins/perf-monitor`. */
export const interactionMetricsPlugin: AppExtension = systemToggle({
  id: 'system:interaction-metrics',
  name: 'Interaction metrics',
  description: 'Records query latency and invalidation fan-out each session so regressions are visible over time.',
}).of([
  interactionMetricsEffectContribution,
  definitionSeedsFacet.of(interactionRecordProp, { source: 'interaction-metrics' }),
  typeSeedsFacet.of(interactionMetricsUIStateType, { source: 'interaction-metrics' }),
])
