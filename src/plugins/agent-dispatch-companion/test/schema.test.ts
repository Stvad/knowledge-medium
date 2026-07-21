// @vitest-environment node
/**
 * The `agent:*` property seeds must stay 1:1 with the AGENT_PROPS protocol
 * (chipState.ts explicitly requires the names stay in sync with the daemon).
 * A drifted seed set — a new AGENT_PROP with no seed, or a name typo — means
 * that key never materializes into synced children on flip, silently breaking
 * cross-device coordination. This guards that invariant at the seed boundary.
 */

import { describe, expect, it } from 'vitest'
import { AGENT_PROPS } from '../chipState.ts'
import { agentProtocolSeeds } from '../schema.ts'

describe('agent protocol property seeds', () => {
  it('declares exactly one seed per AGENT_PROPS entry, keyed by the protocol name', () => {
    const seededNames = agentProtocolSeeds.map(seed => seed.name).sort()
    const protocolNames = Object.values(AGENT_PROPS).sort()
    expect(seededNames).toEqual(protocolNames)
  })

  it('gives every seed a distinct durable seedKey and hides it from the outline', () => {
    const seedKeys = agentProtocolSeeds.map(seed => seed.seedKey)
    expect(new Set(seedKeys).size).toBe(seedKeys.length)   // no collisions
    expect(agentProtocolSeeds.every(seed => seed.hidden)).toBe(true)  // machinery
  })
})
