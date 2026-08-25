import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import type { Repo } from '@/data/repo'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { diagnosticsFacet } from '@/plugins/diagnostics/facet.js'
import { createPerfMonitorDiagnosticSource } from './diagnosticsSource.ts'
import { perfAnalysisEffectContribution } from './schedule.ts'
import { viewPerfTrendActionContribution } from './trendAction.ts'

/** Reads the series the two metrics recorders keep, compares this session
 *  against this device's own recent history, and surfaces the verdict through
 *  the diagnostics seam (so the system-status chip carries it without knowing
 *  anything about performance) plus a trend view for investigations.
 *
 *  A metrics series nothing reads is indistinguishable from no metrics at all,
 *  so a recorder added without a reader here is not finished. */
export const perfMonitorPlugin = ({ repo }: { repo: Repo }): AppExtension =>
  systemToggle({
    id: 'system:perf-monitor',
    name: 'Performance monitor',
    description:
      'Compares this session against this device’s recorded history and flags slowdowns in the system-status indicator.',
  }).of([
    perfAnalysisEffectContribution,
    diagnosticsFacet.of(createPerfMonitorDiagnosticSource(repo), { source: 'perf-monitor' }),
    viewPerfTrendActionContribution,
    // The trend action opens a dialog, which is inert without DialogHost
    // mounted; pull it in so this plugin stands alone. The resolver dedupes the
    // shared contribution by reference, so this registers exactly one host.
    dialogAppMountExtension,
  ])
