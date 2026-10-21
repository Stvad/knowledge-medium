import { FacetRuntime } from '@/facets/facet.js'
import { blockRendererFacet, type BlockRendererRegistration } from '@/extensions/blockInteraction.js'
import { dedupeVariantRegistrations } from '@/facets/variantFacet.js'

/**
 * The registered block renderers, keyed by id — what is installed, not
 * what any particular block resolves to. Reading the facet instead gives
 * a resolver that needs a block, which is the wrong question for "what
 * does this runtime have".
 *
 * Raw contributions come back in registration order, so the precedence
 * sort `FacetRuntime.read` does before combining has to be repeated here:
 * without it an override that LOSES on precedence would still be the one
 * reported, and this surface would name a different renderer than the one
 * the UI runs.
 */
export const readRuntimeRenderers = (
  runtime: FacetRuntime,
): Record<string, BlockRendererRegistration> => {
  const registrations = runtime
    .contributionsById(blockRendererFacet.id)
    .toSorted((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
    .map(contribution => contribution.value as BlockRendererRegistration)

  return Object.fromEntries(
    dedupeVariantRegistrations(registrations).map(registration => [registration.id, registration]),
  )
}
