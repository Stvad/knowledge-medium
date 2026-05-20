import {
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
  type AppMountContribution,
  type HeaderItemContribution,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { Search } from 'lucide-react'
import { FindReplaceDialog } from './FindReplaceDialog.tsx'
import { FindReplaceHeaderItem } from './HeaderItem.tsx'
import { toggleFindReplaceEvent } from './events.ts'
import { findReplaceDataExtension } from './dataExtension.ts'

export {
  FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  FIND_REPLACE_SEARCH_CONTENT_QUERY,
  findReplaceDataExtension,
} from './dataExtension.ts'
export { FindReplaceDialog } from './FindReplaceDialog.tsx'
export { FindReplaceHeaderItem } from './HeaderItem.tsx'
export { toggleFindReplaceEvent } from './events.ts'

export const findReplaceMount: AppMountContribution = {
  id: 'find-replace.dialog',
  component: FindReplaceDialog,
}

export const FIND_REPLACE_ACTION_ID = 'find_replace.open'

export const findReplaceAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: FIND_REPLACE_ACTION_ID,
  description: 'Find and replace',
  context: ActionContextTypes.GLOBAL,
  icon: Search,
  handler: () => {
    window.dispatchEvent(new CustomEvent(toggleFindReplaceEvent))
  },
  defaultBinding: {
    keys: ['cmd+shift+f', 'ctrl+shift+f'],
  },
}

export const findReplaceHeaderItem: HeaderItemContribution = {
  id: 'find-replace.header',
  region: 'end',
  component: FindReplaceHeaderItem,
}

export const findReplacePlugin: AppExtension = [
  findReplaceDataExtension,
  appMountsFacet.of(findReplaceMount, {source: 'find-replace'}),
  actionsFacet.of(findReplaceAction, {source: 'find-replace'}),
  headerItemsFacet.of(findReplaceHeaderItem, {
    source: 'find-replace',
    precedence: 15,
  }),
]
