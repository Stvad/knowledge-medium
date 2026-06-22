import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import type { Repo } from '@/data/repo'
import { diagnosticsFacet } from '@/plugins/diagnostics/facet.js'
import { createDataIntegrityDiagnosticSource } from './diagnosticsSource.ts'
import { consistencyAuditEffectContribution } from './schedule.ts'

/** Owns the built-in consistency audit (L3): the engine + cadenced scheduling
 *  (AppEffect) run here, and the result is surfaced via the diagnostics seam,
 *  which the sync-status chip aggregates. */
export const dataIntegrityPlugin = ({ repo }: { repo: Repo }): AppExtension =>
  systemToggle({
    id: 'system:data-integrity',
    name: 'Data integrity',
    description:
      'Runs the built-in consistency audit and surfaces its health in the sync-status indicator.',
  }).of([
    consistencyAuditEffectContribution,
    diagnosticsFacet.of(createDataIntegrityDiagnosticSource(repo), {
      source: 'data-integrity',
    }),
  ])
