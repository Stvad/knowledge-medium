import { FacetRuntime } from '@/facets/facet.js'
import { blockRendererFacet, type BlockRendererRegistration } from '@/extensions/blockInteraction.js'

/**
 * The registered block renderers, keyed by id — what is installed, not
 * what any particular block resolves to. Reading the facet instead gives
 * a resolver that needs a block, which is the wrong question for "what
 * does this runtime have".
 */
export const readRuntimeRenderers = (
  runtime: FacetRuntime,
): Record<string, BlockRendererRegistration> => {
  const registrations: Record<string, BlockRendererRegistration> = {}
  for (const contribution of runtime.contributionsById(blockRendererFacet.id)) {
    const registration = contribution.value as BlockRendererRegistration
    registrations[registration.id] = registration
  }
  return registrations
}
