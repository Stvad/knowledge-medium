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
 *  drift axis, which is invisible until a join order inverts.
 *
 *  The sibling reader for `LocalSchemaAnalyzeTable.name` — the one-shot
 *  exact-stats repair's table list — is on the warm-boot branch, not here. Both
 *  read the SAME declaration on purpose: the repair set and the probe set are
 *  the same tables, and two fields would let them drift. */
export const resolveAnalyzeArmingProbes = (
  contributions: readonly LocalSchemaContribution[],
): readonly string[] => [
  ...ANALYZE_ARMING_PROBES,
  ...contributions.flatMap(c => (c.analyzeTables ?? []).map(table => table.probe)),
]

let installedProbes: readonly string[] = ANALYZE_ARMING_PROBES

/** The arming probes for the local schema actually INSTALLED in this process.
 *
 *  Module state because it is a process-level fact — one database, one installed
 *  schema — and because deriving it twice is how it goes wrong. The tempting
 *  second source is `repo.facetRuntime`, which is TOGGLE-FILTERED: disabling the
 *  References plugin prunes its contribution from the app runtime, while
 *  `staticDataExtensions` still installs `block_references` and its triggers
 *  unconditionally. A caller reading the filtered set would stop arming a table
 *  the database is still maintaining — silently, since an unarmed table just
 *  quietly stops being re-analyzed on the drift axis.
 *
 *  Falls back to the core probes until {@link applyLocalSchemaContributions}
 *  runs, which is the honest answer before a schema is installed. */
export const installedAnalyzeArmingProbes = (): readonly string[] => installedProbes

export const applyLocalSchemaContributions = async (
  db: LocalSchemaDb,
  contributions: readonly LocalSchemaContribution[],
): Promise<void> => {
  // Recorded here, not at the call site: this function IS "the schema this
  // process installed", so the probe set stays in step with the DDL by
  // construction rather than by two callers remembering to agree.
  installedProbes = resolveAnalyzeArmingProbes(contributions)
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
