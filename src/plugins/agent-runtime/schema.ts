/**
 * Property-definition seed for the agent-runtime reconcile tag.
 *
 * `agent:subtreeKey` tags every block of a keyed reconciled subtree so the
 * reconcile can identify "this subtree" without touching interleaved user
 * content (see `SUBTREE_KEY_PROP` in ./commands.ts). It is app-owned machinery
 * — hidden-tier — but, like every property, must cross devices: seeding it
 * lets the tag materialize into synced children in a child-backed workspace
 * (MATERIALIZE only builds children for a schema-registered key).
 *
 * Sub-path import (not the `@/data/api` barrel via a component tree) — this
 * file is loaded from the static-data graph; keep its imports data-only.
 */

import { ChangeScope, seedProperty } from '@/data/api'

export const agentSubtreeKeyProp = seedProperty({
  seedKey: 'system:agent-runtime/property/subtree-key',
  revision: 1,
  name: 'agent:subtreeKey',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})
