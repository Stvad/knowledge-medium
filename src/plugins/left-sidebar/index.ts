import {
  appMountsFacet,
  headerItemsFacet,
  type AppMountContribution,
  type HeaderItemContribution,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { LeftSidebar, LeftSidebarCoreSection, LeftSidebarShortcutsSection } from './LeftSidebar.tsx'
import { LeftSidebarHeaderItem } from './HeaderItem.tsx'
import { leftSidebarSectionsFacet, type LeftSidebarSectionContribution } from './facet.ts'

export { LeftSidebar } from './LeftSidebar.tsx'
export { LeftSidebarHeaderItem } from './HeaderItem.tsx'
export {
  closeLeftSidebar,
  closeLeftSidebarEvent,
  openLeftSidebar,
  openLeftSidebarEvent,
  toggleLeftSidebar,
  toggleLeftSidebarEvent,
} from './events.ts'
export {
  leftSidebarSectionsFacet,
  type LeftSidebarSectionContribution,
  type LeftSidebarSectionProps,
} from './facet.ts'
export {
  createNodeInActivePanel,
  useActivePanelNodeTarget,
  type ActivePanelNodeTarget,
} from './panelTarget.tsx'

export const leftSidebarMount: AppMountContribution = {
  id: 'left-sidebar.mount',
  component: LeftSidebar,
}

export const leftSidebarHeaderItem: HeaderItemContribution = {
  id: 'left-sidebar.header-trigger',
  region: 'start',
  component: LeftSidebarHeaderItem,
}

export const leftSidebarCoreSection: LeftSidebarSectionContribution = {
  id: 'left-sidebar.core',
  component: LeftSidebarCoreSection,
}

export const leftSidebarShortcutsSection: LeftSidebarSectionContribution = {
  id: 'left-sidebar.shortcuts',
  component: LeftSidebarShortcutsSection,
}

export const leftSidebarPlugin: AppExtension = [
  appMountsFacet.of(leftSidebarMount, {source: 'left-sidebar'}),
  headerItemsFacet.of(leftSidebarHeaderItem, {
    source: 'left-sidebar',
    precedence: -20,
  }),
  leftSidebarSectionsFacet.of(leftSidebarCoreSection, {
    source: 'left-sidebar',
    precedence: 0,
  }),
  leftSidebarSectionsFacet.of(leftSidebarShortcutsSection, {
    source: 'left-sidebar',
    precedence: 10,
  }),
]
