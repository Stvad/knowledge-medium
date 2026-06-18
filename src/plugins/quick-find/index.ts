import {
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
  type HeaderItemContribution,
  type AppMountContribution,
} from '@/extensions/core.js'
import { propertySchemasFacet } from '@/data/facets.js'
import { pluginUIStateExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { Search } from 'lucide-react'
import { QuickFindHeaderItem } from './HeaderItem.tsx'
import { QuickFind } from './QuickFind.tsx'
import { quickFindToggle } from './toggleStore.ts'
import { quickFindUIStateType, recentBlockIdsProp } from './recents.ts'

export { QuickFindHeaderItem } from './HeaderItem.tsx'
export { QuickFind } from './QuickFind.tsx'
export { RECENT_BLOCKS_LIMIT, pushRecentBlockId, recentBlockIdsProp } from './recents.ts'

export const quickFindMount: AppMountContribution = {
  id: 'quick-find.dialog',
  component: QuickFind,
}

export const QUICK_FIND_ACTION_ID = 'quick_find'

export const quickFindAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: QUICK_FIND_ACTION_ID,
  description: 'Find or create page or block',
  context: ActionContextTypes.GLOBAL,
  icon: Search,
  handler: () => {
    quickFindToggle.toggle()
  },
  defaultBinding: {
    keys: '$mod+p',
  },
}

export const quickFindHeaderItem: HeaderItemContribution = {
  id: 'quick-find.header',
  region: 'start',
  component: QuickFindHeaderItem,
}

export const quickFindPlugin: AppExtension = systemToggle({
  id: 'system:quick-find',
  name: 'Quick find',
  description: 'Cmd+P jump-to-block by alias, content, or relative date.',
}).of([
  appMountsFacet.of(quickFindMount, {source: 'quick-find'}),
  propertySchemasFacet.of(recentBlockIdsProp, {source: 'quick-find'}),
  ...pluginUIStateExtension(quickFindUIStateType, 'quick-find'),
  actionsFacet.of(quickFindAction, {source: 'quick-find'}),
  headerItemsFacet.of(quickFindHeaderItem, {
    source: 'quick-find',
    precedence: 10,
  }),
])

export default quickFindPlugin
