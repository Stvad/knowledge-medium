import { describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { leftSidebarSectionsFacet } from '@/plugins/left-sidebar'
import { syncStatusHeaderItem, syncStatusPlugin } from '@/plugins/sync-status'
import {
  pendingInvitationsHeaderItem,
  workspaceHeaderPlugin,
  workspaceSwitcherSidebarSection,
} from '../index'

describe('workspaceHeaderPlugin', () => {
  it('contributes the workspace switcher and invitations', () => {
    const runtime = resolveFacetRuntimeSync(workspaceHeaderPlugin)

    expect(runtime.read(leftSidebarSectionsFacet)).toEqual([workspaceSwitcherSidebarSection])
    expect(runtime.read(headerItemsFacet)).toEqual([pendingInvitationsHeaderItem])
  })

  it('leaves sync status on the end side without a spacer contribution', () => {
    const runtime = resolveFacetRuntimeSync([
      workspaceHeaderPlugin,
      syncStatusPlugin,
    ])

    expect(runtime.read(headerItemsFacet)).toEqual([
      pendingInvitationsHeaderItem,
      syncStatusHeaderItem,
    ])
  })
})
