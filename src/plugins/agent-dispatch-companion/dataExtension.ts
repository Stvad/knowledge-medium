import { definitionSeedsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { agentProtocolSeeds } from './schema.ts'

const SOURCE = 'agent-dispatch-companion'

/** Data-layer half of the agent-dispatch companion: the `agent:*`
 *  property-definition seeds. Kept separate from the UI plugin
 *  (./index.ts) so data ownership is registered without importing the
 *  component tree — the static-data-extensions convention. */
export const agentDispatchCompanionDataExtension: AppExtension =
  agentProtocolSeeds.map(seed => definitionSeedsFacet.of(seed, {source: SOURCE}))
