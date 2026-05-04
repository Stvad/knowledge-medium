import {
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
  type HeaderItemContribution,
  type AppMountContribution,
} from '@/extensions/core.ts'
import { propertySchemasFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { QuickFindHeaderItem } from './HeaderItem.tsx'
import { QuickFind } from './QuickFind.tsx'
import { toggleQuickFindEvent } from './events.ts'
import { recentBlockIdsProp } from './recents.ts'

export { QuickFindHeaderItem } from './HeaderItem.tsx'
export { QuickFind } from './QuickFind.tsx'
export { toggleQuickFindEvent } from './events.ts'
export { RECENT_BLOCKS_LIMIT, pushRecentBlockId, recentBlockIdsProp } from './recents.ts'

export const quickFindMount: AppMountContribution = {
  id: 'quick-find.dialog',
  component: QuickFind,
}

export const quickFindAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'quick_find',
  description: 'Find or create page or block',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
  },
  defaultBinding: {
    keys: ['cmd+p', 'ctrl+p', 'cmd+shift+k', 'ctrl+shift+k'],
  },
}

export const quickFindHeaderItem: HeaderItemContribution = {
  id: 'quick-find.header',
  region: 'end',
  component: QuickFindHeaderItem,
}

export const quickFindPlugin: AppExtension = [
  appMountsFacet.of(quickFindMount, {source: 'quick-find'}),
  propertySchemasFacet.of(recentBlockIdsProp, {source: 'quick-find'}),
  actionsFacet.of(quickFindAction, {source: 'quick-find'}),
  headerItemsFacet.of(quickFindHeaderItem, {
    source: 'quick-find',
    precedence: 10,
  }),
]
