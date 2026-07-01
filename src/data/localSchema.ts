import type { AppExtension } from '@/facets/facet.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  localSchemaFacet,
  type LocalSchemaContribution,
  type LocalSchemaDb,
} from './facets.ts'

/** Collect `localSchemaFacet` contributions from a UI-free extension list,
 *  via the facet system (NOT a hand-listed set of contributions). Used by
 *  the pre-observer / pre-React local-DDL path (`repoProvider`,
 *  `createTestDb`, the bench) off `pluginDataExtensions`. Toggle-blind
 *  (bare collector): local tables/triggers are provisioned regardless of a
 *  plugin's enabled state, so toggling one on mid-session never hits a
 *  missing table. */
export const resolveLocalSchemaContributions = (
  extensions: readonly AppExtension[],
): readonly LocalSchemaContribution[] =>
  resolveFacetRuntimeSync(extensions).read(localSchemaFacet)

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
