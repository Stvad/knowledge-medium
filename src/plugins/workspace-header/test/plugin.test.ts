import { describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  pendingInvitationsHeaderItem,
  workspaceHeaderPlugin,
  workspaceSwitcherHeaderItem,
} from '../index.ts'

describe('workspaceHeaderPlugin', () => {
  it('contributes workspace header items', () => {
    const runtime = resolveFacetRuntimeSync(workspaceHeaderPlugin)

    expect(runtime.read(headerItemsFacet)).toEqual([
      workspaceSwitcherHeaderItem,
      pendingInvitationsHeaderItem,
    ])
  })
})
