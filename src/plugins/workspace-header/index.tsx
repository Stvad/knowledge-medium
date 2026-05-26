import { PendingInvitations } from '@/components/workspace/PendingInvitations.js'
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher.js'
import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
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

export const HeaderSpacerItem = () => (
  <div aria-hidden="true" className="min-w-0 flex-1"/>
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

export const headerSpacerItem: HeaderItemContribution = {
  id: 'workspace-header.spacer',
  region: 'end',
  component: HeaderSpacerItem,
}

export const workspaceHeaderPlugin: AppExtension = systemToggle({
  id: 'system:workspace-header',
  name: 'Workspace header',
  description: 'Top-of-app header with the workspace switcher.',
  essential: true,
}).of([
  leftSidebarSectionsFacet.of(workspaceSwitcherSidebarSection, {
    source: 'workspace-header',
    precedence: -20,
  }),
  headerItemsFacet.of(pendingInvitationsHeaderItem, {
    source: 'workspace-header',
    precedence: 30,
  }),
  headerItemsFacet.of(headerSpacerItem, {
    source: 'workspace-header',
    precedence: 37,
  }),
])
