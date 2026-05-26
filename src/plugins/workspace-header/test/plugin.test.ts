import { describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { leftSidebarSectionsFacet } from '@/plugins/left-sidebar'
import { syncStatusHeaderItem, syncStatusPlugin } from '@/plugins/sync-status'
import {
  headerSpacerItem,
  pendingInvitationsHeaderItem,
  workspaceHeaderPlugin,
  workspaceSwitcherSidebarSection,
} from '../index'

describe('workspaceHeaderPlugin', () => {
  it('contributes the workspace switcher, invitations, and header spacer', () => {
    const runtime = resolveFacetRuntimeSync(workspaceHeaderPlugin)

    expect(runtime.read(leftSidebarSectionsFacet)).toEqual([workspaceSwitcherSidebarSection])
    expect(runtime.read(headerItemsFacet)).toEqual([
      pendingInvitationsHeaderItem,
      headerSpacerItem,
    ])
  })

  it('places the spacer before sync status so sync stays on the right side', () => {
    const runtime = resolveFacetRuntimeSync([
      workspaceHeaderPlugin,
      syncStatusPlugin,
    ])

    expect(runtime.read(headerItemsFacet)).toEqual([
      pendingInvitationsHeaderItem,
      headerSpacerItem,
      syncStatusHeaderItem,
    ])
  })
})
