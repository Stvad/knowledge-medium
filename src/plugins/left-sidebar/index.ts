import {
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
  type AppMountContribution,
  type HeaderItemContribution,
} from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { LeftSidebar, LeftSidebarCoreSection, LeftSidebarShortcutsSection } from './LeftSidebar.tsx'
import { LeftSidebarHeaderItem } from './HeaderItem.tsx'
import { leftSidebarSectionsFacet, type LeftSidebarSectionContribution } from './facet.ts'
import { leftSidebarActions } from './actions.ts'

export { LeftSidebar } from './LeftSidebar.tsx'
export { LeftSidebarHeaderItem } from './HeaderItem.tsx'
export {
  leftSidebarSectionsFacet,
  type LeftSidebarSectionContribution,
  type LeftSidebarSectionProps,
} from './facet.ts'
export {
  OPEN_LEFT_SIDEBAR_ACTION_ID,
  leftSidebarActions,
  openLeftSidebarAction,
} from './actions.ts'

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

export const leftSidebarPlugin: AppExtension = systemToggle({
  id: 'system:left-sidebar',
  name: 'Left sidebar',
  description: 'Collapsible sidebar with section contributions from other plugins.',
}).of([
  leftSidebarActions.map(action => actionsFacet.of(action, {source: 'left-sidebar'})),
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
])

export default leftSidebarPlugin
