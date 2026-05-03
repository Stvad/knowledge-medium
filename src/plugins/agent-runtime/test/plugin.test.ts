import { describe, expect, it } from 'vitest'
import { actionsFacet, appEffectsFacet, appMountsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { agentRuntimePlugin } from '../index.ts'

describe('agentRuntimePlugin', () => {
  it('contributes the bridge as an app effect', () => {
    const runtime = resolveFacetRuntimeSync(agentRuntimePlugin)
    const effects = runtime.read(appEffectsFacet)

    expect(effects.map(effect => effect.id)).toContain('agent-runtime.bridge')
  })

  it('contributes the token dialog as a root mount', () => {
    const runtime = resolveFacetRuntimeSync(agentRuntimePlugin)
    const mounts = runtime.read(appMountsFacet)

    expect(mounts.map(mount => mount.id)).toContain('agent-runtime.tokens-dialog')
  })

  it('contributes agent runtime management actions', () => {
    const runtime = resolveFacetRuntimeSync(agentRuntimePlugin)
    const actions = runtime.read(actionsFacet)

    expect(actions.map(action => action.id)).toEqual(
      expect.arrayContaining([
        'restart_agent_runtime_bridge',
        'manage_agent_tokens',
      ]),
    )
  })
})
