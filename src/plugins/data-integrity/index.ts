import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import type { Repo } from '@/data/repo'
import { diagnosticsFacet } from '@/plugins/diagnostics/facet.js'
import { createDataIntegrityDiagnosticSource } from './diagnosticsSource.ts'

/** Surfaces the built-in consistency-audit (L3) health in the diagnostics seam,
 *  which the sync-status chip aggregates. The audit engine + scheduling still
 *  live in core for now (a later step moves them here). */
export const dataIntegrityPlugin = ({ repo }: { repo: Repo }): AppExtension =>
  systemToggle({
    id: 'system:data-integrity',
    name: 'Data integrity',
    description:
      'Surfaces the built-in consistency-audit health in the sync-status indicator.',
  }).of([
    diagnosticsFacet.of(createDataIntegrityDiagnosticSource(repo), {
      source: 'data-integrity',
    }),
  ])
