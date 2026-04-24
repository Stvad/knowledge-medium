import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/block.ts'
import type { Repo } from '@/data/repo.ts'
import {
  blockInteractionPolicyFacet,
  BlockInteractionContext,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  plainOutlinerBlockInteractionPolicy,
  vimBlockInteractionPolicy,
} from '@/shortcuts/blockInteractionPolicies.ts'

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {} as Block,
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
} satisfies BlockInteractionContext

describe('block interaction policy facet', () => {
  it('uses the plain outliner policy as the non-vim fallback', () => {
    const runtime = resolveFacetRuntimeSync([
      blockInteractionPolicyFacet.of(plainOutlinerBlockInteractionPolicy),
    ])

    const policy = runtime.read(blockInteractionPolicyFacet)(context)

    expect(policy.contentMode).toBe('preview')
    expect(policy.activateNormalMode).toBe(false)
    expect(policy.handleBlockClick).toBeDefined()
    expect(policy.handleContentDoubleClick).toBeUndefined()
  })

  it('lets vim mode override block interaction behavior', () => {
    const runtime = resolveFacetRuntimeSync([
      blockInteractionPolicyFacet.of(plainOutlinerBlockInteractionPolicy),
      blockInteractionPolicyFacet.of(vimBlockInteractionPolicy, {precedence: 100}),
    ])

    const policy = runtime.read(blockInteractionPolicyFacet)(context)

    expect(policy.contentMode).toBe('preview')
    expect(policy.activateNormalMode).toBe(true)
    expect(policy.handleBlockClick).toBeDefined()
    expect(policy.handleContentDoubleClick).toBeDefined()
    expect(policy.handleContentTap).toBeDefined()
  })

  it('does not activate normal mode while vim is editing', () => {
    const runtime = resolveFacetRuntimeSync([
      blockInteractionPolicyFacet.of(vimBlockInteractionPolicy),
    ])

    const policy = runtime.read(blockInteractionPolicyFacet)({
      ...context,
      inEditMode: true,
    })

    expect(policy.contentMode).toBe('editor')
    expect(policy.activateNormalMode).toBe(false)
  })
})
