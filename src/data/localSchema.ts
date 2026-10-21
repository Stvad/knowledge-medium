import type { AppExtension } from '@/facets/facet.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { CORE_ANALYZE_TABLES } from './internals/clientSchema.ts'
import {
  localSchemaFacet,
  type LocalSchemaAnalyzeTable,
  type LocalSchemaContribution,
  type LocalSchemaDb,
} from './facets.ts'

export const resolveLocalSchemaContributions = (
  extensions: readonly AppExtension[],
): readonly LocalSchemaContribution[] =>
  resolveFacetRuntimeSync(extensions).read(localSchemaFacet)

/** The core hot tables plus whatever the installed contributions bring. The
 *  probe set and the name set are read off this ONE list on purpose: they are
 *  the same tables, and two lists would let them drift. */
export const resolveAnalyzeTables = (
  contributions: readonly LocalSchemaContribution[],
): readonly LocalSchemaAnalyzeTable[] => [
  ...CORE_ANALYZE_TABLES,
  ...contributions.flatMap(c => c.analyzeTables ?? []),
]

let installedTables: readonly LocalSchemaAnalyzeTable[] = CORE_ANALYZE_TABLES

/** The arming probes for the local schema actually INSTALLED in this process,
 *  for `runAnalyzeIfStale`. A plugin table left out is simply never re-analyzed
 *  on the drift axis, which is invisible until a join order inverts.
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
export const installedAnalyzeArmingProbes = (): readonly string[] =>
  installedTables.map(table => table.probe)

/** The same installed tables by name, for `runAnalyzeInstalledTables`. Same
 *  source, and the same reason not to read the runtime. */
export const installedAnalyzeTableNames = (): readonly string[] =>
  installedTables.map(table => table.name)

export const applyLocalSchemaContributions = async (
  db: LocalSchemaDb,
  contributions: readonly LocalSchemaContribution[],
): Promise<void> => {
  // Recorded here, not at the call site: this function IS "the schema this
  // process installed", so the probe set stays in step with the DDL by
  // construction rather than by two callers remembering to agree.
  installedTables = resolveAnalyzeTables(contributions)
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
