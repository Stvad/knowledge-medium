import { describe, expect, it } from 'vitest'
import { appEffectsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { agentRuntimePlugin } from '../index.ts'

describe('agentRuntimePlugin', () => {
  it('contributes the bridge as an app effect', () => {
    const runtime = resolveFacetRuntimeSync(agentRuntimePlugin)
    const effects = runtime.read(appEffectsFacet)

    expect(effects.map(effect => effect.id)).toContain('agent-runtime.bridge')
  })
})
