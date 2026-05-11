import { PendingInvitations } from '@/components/workspace/PendingInvitations.tsx'
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher.tsx'
import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  leftSidebarSectionsFacet,
  type LeftSidebarSectionContribution,
} from '@/plugins/left-sidebar'

export const WorkspaceSwitcherSidebarSection = () => (
  <section>
    <WorkspaceSwitcher
      triggerClassName="h-11 w-full max-w-none justify-between rounded-lg border border-border px-3 text-base"
    />
  </section>
)

export const workspaceSwitcherSidebarSection: LeftSidebarSectionContribution = {
  id: 'workspace-header.switcher',
  component: WorkspaceSwitcherSidebarSection,
}

export const pendingInvitationsHeaderItem: HeaderItemContribution = {
  id: 'workspace-header.pending-invitations',
  region: 'end',
  component: PendingInvitations,
}

export const workspaceHeaderPlugin: AppExtension = [
  leftSidebarSectionsFacet.of(workspaceSwitcherSidebarSection, {
    source: 'workspace-header',
    precedence: -20,
  }),
  headerItemsFacet.of(pendingInvitationsHeaderItem, {
    source: 'workspace-header',
    precedence: 30,
  }),
]
