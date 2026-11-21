/**
 * Surfaces degraded block search on the status chip.
 *
 * Two contributions, one direction: it observes core's search merge point via
 * `searchSourceHealthFacet` and republishes what it learns through the
 * diagnostics seam. Core names neither this plugin nor the chip — it only
 * emits events to whoever registered, which is what lets a health indicator
 * exist for a core code path without core depending on the plugin layer.
 */
import { searchSourceHealthFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { diagnosticsFacet, type DiagnosticSourceContribution } from '@/plugins/diagnostics/facet.js'
import {
  recordSearchSourceHealth,
  searchSourceHealthSnapshot,
  subscribeSearchSourceHealth,
} from './store.js'

export const searchHealthDiagnosticSource: DiagnosticSourceContribution = {
  id: 'search-health',
  label: 'Search',
  subscribe: subscribeSearchSourceHealth,
  getSnapshot: searchSourceHealthSnapshot,
}

export const searchHealthExtension: AppExtension = [
  searchSourceHealthFacet.of(
    {id: 'search-health', report: recordSearchSourceHealth},
    {source: 'search-health'},
  ),
  diagnosticsFacet.of(searchHealthDiagnosticSource, {source: 'search-health'}),
]
