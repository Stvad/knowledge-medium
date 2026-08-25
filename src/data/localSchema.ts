import type { AppExtension } from '@/facets/facet.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { ANALYZE_ARMING_PROBES } from './internals/clientSchema.ts'
import {
  localSchemaFacet,
  type LocalSchemaContribution,
  type LocalSchemaDb,
} from './facets.ts'

export const resolveLocalSchemaContributions = (
  extensions: readonly AppExtension[],
): readonly LocalSchemaContribution[] =>
  resolveFacetRuntimeSync(extensions).read(localSchemaFacet)

/** The core probes plus whatever the installed contributions bring, for
 *  `runAnalyzeIfStale`. Every caller that can reach the contributions should go
 *  through here: a plugin table left out is simply never re-analyzed on the
 *  drift axis, which is invisible until a join order inverts. */
export const resolveAnalyzeArmingProbes = (
  contributions: readonly LocalSchemaContribution[],
): readonly string[] => [
  ...ANALYZE_ARMING_PROBES,
  ...contributions.flatMap(contribution => contribution.analyzeProbes ?? []),
]

export const applyLocalSchemaContributions = async (
  db: LocalSchemaDb,
  contributions: readonly LocalSchemaContribution[],
): Promise<void> => {
  for (const contribution of contributions) {
    for (const statement of contribution.statements ?? []) {
      await db.execute(statement)
    }
  }

  for (const contribution of contributions) {
    for (const backfill of contribution.backfills ?? []) {
      await backfill.run(db)
    }
  }
}
