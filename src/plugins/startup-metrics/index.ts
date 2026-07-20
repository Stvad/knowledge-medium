import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { appEffectsFacet } from '@/extensions/core.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import {
  collectStartupMetricsEffect,
  startupMetricsUIStateType,
  startupRecordProp,
} from './record.ts'

/** Records a durable per-session cold-start timeline (TTI + settled + the phase
 *  breakdown) as a block-per-session under a hidden ui-state subtree, so
 *  loading-time trends are observable over builds instead of ephemeral. */
export const startupMetricsPlugin: AppExtension = systemToggle({
  id: 'system:startup-metrics',
  name: 'Startup metrics',
  description: 'Records time-to-interactivity and settle timings each load so regressions are visible over time.',
}).of([
  appEffectsFacet.of(collectStartupMetricsEffect, { source: 'startup-metrics' }),
  definitionSeedsFacet.of(startupRecordProp, { source: 'startup-metrics' }),
  typeSeedsFacet.of(startupMetricsUIStateType, { source: 'startup-metrics' }),
])
