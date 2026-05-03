import { PendingInvitations } from '@/components/workspace/PendingInvitations.tsx'
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher.tsx'
import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'

export const workspaceSwitcherHeaderItem: HeaderItemContribution = {
  id: 'workspace-header.switcher',
  region: 'start',
  component: WorkspaceSwitcher,
}

export const pendingInvitationsHeaderItem: HeaderItemContribution = {
  id: 'workspace-header.pending-invitations',
  region: 'end',
  component: PendingInvitations,
}

export const workspaceHeaderPlugin: AppExtension = [
  headerItemsFacet.of(workspaceSwitcherHeaderItem, {
    source: 'workspace-header',
    precedence: 0,
  }),
  headerItemsFacet.of(pendingInvitationsHeaderItem, {
    source: 'workspace-header',
    precedence: 30,
  }),
]
