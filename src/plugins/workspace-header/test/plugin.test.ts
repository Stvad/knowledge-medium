import { describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { leftSidebarSectionsFacet } from '@/plugins/left-sidebar'
import {
  pendingInvitationsHeaderItem,
  workspaceHeaderPlugin,
  workspaceSwitcherSidebarSection,
} from '../index'

describe('workspaceHeaderPlugin', () => {
  it('contributes the workspace switcher to the sidebar and invitations to the header', () => {
    const runtime = resolveFacetRuntimeSync(workspaceHeaderPlugin)

    expect(runtime.read(leftSidebarSectionsFacet)).toEqual([workspaceSwitcherSidebarSection])
    expect(runtime.read(headerItemsFacet)).toEqual([pendingInvitationsHeaderItem])
  })
})
