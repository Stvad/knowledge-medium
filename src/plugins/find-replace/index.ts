import {
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
  type AppMountContribution,
  type HeaderItemContribution,
} from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { Search } from 'lucide-react'
import { FindReplaceDialog } from './FindReplaceDialog.tsx'
import { FindReplaceHeaderItem } from './HeaderItem.tsx'
import { findReplaceToggle } from './toggleStore.ts'
import { findReplaceDataExtension } from './dataExtension.ts'

export {
  FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  FIND_REPLACE_SEARCH_CONTENT_QUERY,
  findReplaceDataExtension,
} from './dataExtension.ts'
export { FindReplaceDialog } from './FindReplaceDialog.tsx'
export { FindReplaceHeaderItem } from './HeaderItem.tsx'

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
    findReplaceToggle.toggle()
  },
  defaultBinding: {
    keys: '$mod+Shift+f',
  },
}

export const findReplaceHeaderItem: HeaderItemContribution = {
  id: 'find-replace.header',
  region: 'start',
  component: FindReplaceHeaderItem,
}

/** Nested toggle for the search icon in the header. Sits inside the
 *  outer `system:find-replace` boundary, so disabling find-replace
 *  drops everything including this item. Disabling just this inner
 *  toggle removes the icon from the header while keeping the
 *  Cmd+Shift+F action and the dialog wired — users who navigate via
 *  the keyboard or command palette can still open find-replace, just
 *  without the header affordance. */
const findReplaceHeaderToggle = systemToggle({
  id: 'system:find-replace/header-item',
  name: 'Search icon in header',
  description: 'Disable to hide find-replace from the global header (Cmd+Shift+F still works).',
  defaultEnabled: false,
})

export const findReplacePlugin: AppExtension = systemToggle({
  id: 'system:find-replace',
  name: 'Find and replace',
  description: 'Cmd+Shift+F search-and-replace across the workspace.',
}).of([
  findReplaceDataExtension,
  appMountsFacet.of(findReplaceMount, {source: 'find-replace'}),
  actionsFacet.of(findReplaceAction, {source: 'find-replace'}),
  findReplaceHeaderToggle.of(
    headerItemsFacet.of(findReplaceHeaderItem, {
      source: 'find-replace',
      precedence: 15,
    }),
  ),
])

export default findReplacePlugin
