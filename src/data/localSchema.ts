import type { AppExtension } from '@/extensions/facet.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  localSchemaFacet,
  type LocalSchemaContribution,
  type LocalSchemaDb,
} from './facets.ts'

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
