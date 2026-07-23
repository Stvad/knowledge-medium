import { definitionSeedsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { agentSubtreeKeyProp } from './schema.ts'

/** Data-layer ownership for agent-runtime: the `agent:subtreeKey` reconcile
 *  tag's property-definition seed. Kept UI-free (schema only) so it can join
 *  the static-data graph without dragging the runtime/bridge module tree. */
export const agentRuntimeDataExtension: AppExtension = [
  definitionSeedsFacet.of(agentSubtreeKeyProp, {source: 'agent-runtime'}),
]
