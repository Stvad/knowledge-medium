/**
 * Property-definition seeds for the `agent:*` task-lifecycle protocol shared
 * with the agent-dispatch daemon (packages/agent-dispatch/src/config.ts PROPS
 * — the names here must stay in sync with `AGENT_PROPS` in ./chipState.ts and
 * that daemon module).
 *
 * Why seed these at all: there is no local-only property tier — every property
 * is meant to cross devices. In a child-backed workspace the field/value
 * children are the only property truth that syncs, and MATERIALIZE only builds
 * children for a bag key that has a registered schema. Without these seeds the
 * `agent:*` keys would materialize into nothing and the daemon's cross-device
 * coordination would silently stop syncing on flip. Seeding also lets the
 * companion's own writes move off the raw property bag onto the typed
 * `setProperty` / `setProperties` / `unsetProperty` primitives.
 *
 * All hidden-tier: the AgentStatusChip renders this state; the raw props are
 * machinery, never visible outline children.
 *
 * Codec choices follow the daemon's observed value shapes:
 *  - `agent:reply` is the boolean marker `true` on daemon-authored reply
 *    blocks (graph.ts).
 *  - `agent:cancel` holds a `Date.now()` number when the app requests a stop
 *    and `''` when the daemon clears it — a mixed number|string, so it takes
 *    the identity (`raw-json`) codec to round-trip both without a codec break.
 *  - `agent:resume-options` is a structured object or absent (`optional-json`).
 */

import { ChangeScope, seedProperty } from '@/data/api'

const scope = ChangeScope.BlockDefault

export const agentStatusProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/status',
  revision: 1,
  name: 'agent:status',
  preset: 'string',
  defaultValue: '',
  changeScope: scope,
  hidden: true,
})

export const agentExecutorProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/executor',
  revision: 1,
  name: 'agent:executor',
  preset: 'string',
  defaultValue: '',
  changeScope: scope,
  hidden: true,
})

export const agentWatcherProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/watcher',
  revision: 1,
  name: 'agent:watcher',
  preset: 'string',
  defaultValue: '',
  changeScope: scope,
  hidden: true,
})

export const agentSessionProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/session',
  revision: 1,
  name: 'agent:session',
  preset: 'string',
  defaultValue: '',
  changeScope: scope,
  hidden: true,
})

export const agentResumeOptionsProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/resume-options',
  revision: 1,
  name: 'agent:resume-options',
  preset: 'optional-json',
  changeScope: scope,
  hidden: true,
})

export const agentUpdatedAtProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/updated-at',
  revision: 1,
  name: 'agent:updated-at',
  preset: 'number',
  defaultValue: 0,
  changeScope: scope,
  hidden: true,
})

export const agentAttemptsProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/attempts',
  revision: 1,
  name: 'agent:attempts',
  preset: 'number',
  defaultValue: 0,
  changeScope: scope,
  hidden: true,
})

export const agentErrorProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/error',
  revision: 1,
  name: 'agent:error',
  preset: 'string',
  defaultValue: '',
  changeScope: scope,
  hidden: true,
})

export const agentReplyProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/reply',
  revision: 1,
  name: 'agent:reply',
  preset: 'boolean',
  defaultValue: false,
  changeScope: scope,
  hidden: true,
})

export const agentActivityProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/activity',
  revision: 1,
  name: 'agent:activity',
  preset: 'string',
  defaultValue: '',
  changeScope: scope,
  hidden: true,
})

export const agentAskedAtProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/asked-at',
  revision: 1,
  name: 'agent:asked-at',
  preset: 'number',
  defaultValue: 0,
  changeScope: scope,
  hidden: true,
})

export const agentCancelProp = seedProperty({
  seedKey: 'system:agent-dispatch-companion/property/cancel',
  revision: 1,
  name: 'agent:cancel',
  preset: 'raw-json',
  changeScope: scope,
  hidden: true,
})

/** Every agent-protocol seed, in `AGENT_PROPS` order. */
export const agentProtocolSeeds = [
  agentStatusProp,
  agentExecutorProp,
  agentWatcherProp,
  agentSessionProp,
  agentResumeOptionsProp,
  agentUpdatedAtProp,
  agentAttemptsProp,
  agentErrorProp,
  agentReplyProp,
  agentActivityProp,
  agentAskedAtProp,
  agentCancelProp,
] as const
