import { describe, expect, it } from 'vitest'
import { appEffectsFacet, appMountsFacet } from '@/extensions/core.ts'
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
})
